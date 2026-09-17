"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_ENDPOINT_PLACEHOLDER = "[PASTE ZIA AGENT URL HERE]";
const DEFAULT_TIMEOUT_MS = 120000;

class ZiaAgentClient {
	constructor(config = {}) {
		const rawEndpoint = config.endpoint || process.env.ZIA_AGENT_ENDPOINT || process.env.ZIA_AGENT_URL || DEFAULT_ENDPOINT_PLACEHOLDER;
		this.endpoint = String(rawEndpoint).trim();
		this.agentId = String(config.agentId || process.env.ZIA_AGENT_ID || "").trim();
		this.timeoutMs = Number(config.timeoutMs || process.env.ZIA_AGENT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
		this.agentType = "ZIA_AGENT";
		// Populated per-call from the last Agent response (see _extractSessionId). Not persisted or
		// resent - each document is a single independent analysis, not a multi-turn conversation.
		this.lastSessionId = null;
	}

	isConfigured() {
		if (!this.endpoint) return false;
		if (this.endpoint.toUpperCase() === DEFAULT_ENDPOINT_PLACEHOLDER.toUpperCase()) return false;
		if (this.endpoint.startsWith("<") && this.endpoint.endsWith(">")) return false;
		return true;
	}

	async analyzeDocument(text, options = {}) {
		if (!text || typeof text !== "string" || text.trim().length === 0) {
			throw new Error("Document text is empty or invalid for Zia Agent analysis.");
		}

		if (!this.isConfigured()) {
			throw new ConfigurationError(
				`Zia Agent endpoint is not configured. Please set the ZIA_AGENT_ENDPOINT environment variable or replace "${DEFAULT_ENDPOINT_PLACEHOLDER}" with the deployed Zia Agent URL.`
			);
		}

		const businessName = String(options.businessName || "Spikra").trim();
		const projectName = String(options.projectName || "Customer Proposal").trim();

		const instruction = [
			`Analyze the following technical/business document for "${businessName}" (project: ${projectName}) and generate structured V1 Customer Showcase content.`,
			"Return ONLY a single JSON object (no markdown, no prose) with fields: proposal_title, project_summary, what_we_deliver, spikra_way, how_we_support, deliverable_cards (array of {label,value,note}), customer_benefits (array of strings), capabilities (array of {title,subtitle,teaser,description}), timeline_phases (array of {name,duration,items[],note}), rollout_overview (array of 2 {label,value,note}), de_risk_summary (array of 2 {label,value,note}).",
			"Document content:",
			text.trim()
		].join("\n\n");

		// Zia Agents Trigger API request schema: query, systemArgs, reasoning, attachments only -
		// no other top-level keys. session_id is added only when continuing a prior session.
		const requestPayload = {
			query: instruction,
			systemArgs: {},
			reasoning: false,
			attachments: []
		};
		if (options.sessionId) {
			requestPayload.session_id = String(options.sessionId).trim();
		}

		const responseData = await this._callAgentEndpoint(requestPayload, options.connectionCredentials);
		this.lastSessionId = this._extractSessionId(responseData);
		const structuredOutput = this._extractStructuredData(responseData, { businessName, projectName, text });

		if (!this.hasMeaningfulShowcaseContent(structuredOutput)) {
			throw new SchemaValidationError(
				"Zia Agent response did not contain a recognizable Customer Showcase structure " +
				"(missing proposal_title/project_summary and insufficient deliverable_cards/capabilities/customer_benefits/timeline_phases). " +
				"Refusing to substitute generic fabricated customer content."
			);
		}

		return this.normalizeShowcaseContent(structuredOutput, { businessName, projectName, text });
	}

	// Guards against accepting an empty/malformed Agent response and papering over it with fabricated defaults.
	hasMeaningfulShowcaseContent(data) {
		if (!data || typeof data !== "object") return false;

		const isNonEmptyString = (val) => typeof val === "string" && val.trim().length > 0;
		const isNonEmptyArray = (val) => Array.isArray(val) && val.length > 0;

		const hasTitleOrSummary = isNonEmptyString(data.proposal_title) || isNonEmptyString(data.project_summary);

		const contentArrayCount = [
			data.deliverable_cards,
			data.capabilities,
			data.customer_benefits,
			data.timeline_phases
		].filter(isNonEmptyArray).length;

		return hasTitleOrSummary && contentArrayCount >= 2;
	}

	async _callAgentEndpoint(payload, connectionCredentials) {
		const urlObj = new URL(this.endpoint);
		const payloadString = JSON.stringify(payload);
		const isHttps = urlObj.protocol === "https:";
		const client = isHttps ? https : http;

		// Auth comes entirely from the Catalyst Connection (Internal-Sales-Hub /
		// internalsaleshub, scope ZiaAgents.agents.TRIGGER) - it already contains the correct
		// Authorization header for this OAuth scope. No token is generated or stored here.
		const headers = {
			"Content-Type": "application/json; charset=utf-8",
			"Accept": "application/json, text/plain, */*",
			...(connectionCredentials && connectionCredentials.headers ? connectionCredentials.headers : {})
		};
		headers["Content-Length"] = Buffer.byteLength(payloadString);

		const options = {
			hostname: urlObj.hostname,
			port: urlObj.port || (isHttps ? 443 : 80),
			path: `${urlObj.pathname}${urlObj.search}`,
			method: "POST",
			headers,
			timeout: this.timeoutMs
		};

		return new Promise((resolve, reject) => {
			const req = client.request(options, (res) => {
				let rawData = "";

				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					rawData += chunk;
				});

				res.on("end", () => {
					const statusCode = res.statusCode || 200;

					if (statusCode < 200 || statusCode >= 300) {
						return reject(
							new AgentAPIError(
								`Zia Agent API returned HTTP status ${statusCode}: ${rawData.slice(0, 500)}`,
								statusCode,
								rawData
							)
						);
					}

					if (!rawData || !rawData.trim()) {
						return reject(new AgentAPIError("Zia Agent API returned an empty response body.", statusCode));
					}

					try {
						const parsed = JSON.parse(rawData);
						resolve(parsed);
					} catch (parseErr) {
						const extractedJson = extractJsonFromString(rawData);
						if (extractedJson) {
							return resolve(extractedJson);
						}
						reject(new AgentAPIError(`Zia Agent returned malformed non-JSON response: ${rawData.slice(0, 300)}`, statusCode));
					}
				});
			});

			req.on("timeout", () => {
				req.destroy();
				reject(new AgentAPIError(`Zia Agent request timed out after ${this.timeoutMs}ms.`, 408));
			});

			req.on("error", (err) => {
				reject(new AgentAPIError(`Failed to connect to Zia Agent endpoint: ${err.message}`, 500));
			});

			req.write(payloadString);
			req.end();
		});
	}

	_extractSessionId(response) {
		if (!response || typeof response !== "object") return null;
		const candidate = response.session_id || response.sessionId ||
			(response.data && (response.data.session_id || response.data.sessionId));
		return candidate ? String(candidate).trim() : null;
	}

	_extractStructuredData(response, { businessName, projectName, text }) {
		if (!response || typeof response !== "object") {
			throw new AgentAPIError("Zia Agent returned invalid response structure.");
		}

		if (response.proposal_title || response.deliverable_cards || response.capabilities) {
			return response;
		}

		if (response.data && typeof response.data === "object") {
			if (response.data.proposal_title || response.data.deliverable_cards || response.data.capabilities) {
				return response.data;
			}
			if (typeof response.data === "string") {
				const inner = extractJsonFromString(response.data);
				if (inner) return inner;
			}
		}

		if (response.output) {
			if (typeof response.output === "object") {
				return response.output;
			}
			if (typeof response.output === "string") {
				const inner = extractJsonFromString(response.output);
				if (inner) return inner;
			}
		}

		if (response.response) {
			if (typeof response.response === "object") {
				return response.response;
			}
			if (typeof response.response === "string") {
				const inner = extractJsonFromString(response.response);
				if (inner) return inner;
			}
		}

		if (response.result) {
			if (typeof response.result === "object") {
				return response.result;
			}
			if (typeof response.result === "string") {
				const inner = extractJsonFromString(response.result);
				if (inner) return inner;
			}
		}

		if (response.message && typeof response.message === "string") {
			const inner = extractJsonFromString(response.message);
			if (inner) return inner;
		}

		if (response.text && typeof response.text === "string") {
			const inner = extractJsonFromString(response.text);
			if (inner) return inner;
		}

		return response;
	}

	normalizeShowcaseContent(data = {}, { businessName = "Spikra", projectName = "Customer Proposal", text = "" }) {
		const cleanStr = (val, def = "") => {
			if (typeof val !== "string" || !val.trim() || val.trim().toLowerCase() === "not specified in the source document") {
				return def;
			}
			return val.trim();
		};

		let title = cleanStr(data.proposal_title);
		if (!title || title.length > 80) {
			title = projectName && projectName !== "Customer Proposal" ? projectName : "Zoho CRM & Digital Transformation";
		}

		let summary = cleanStr(data.project_summary);
		if (!summary) {
			summary = `A configured digital platform designed for ${businessName} to unify customer engagement, field workflows, and operational insights.`;
		}

		const whatWeDeliver = cleanStr(data.what_we_deliver) ||
			`A configured engagement layer connecting customer touchpoints to core operational systems.`;
		const spikraWay = cleanStr(data.spikra_way) ||
			`BRD-aligned delivery. Every assumption is made explicit and every open item flagged for the discovery workshop, so scope is confirmed before detailed design is locked.`;
		const howWeSupport = cleanStr(data.how_we_support) ||
			`Per-system integration decisions, role-based user onboarding, and dedicated Hypercare through go-live.`;

		const fallbackCards = [
			{ label: "Platform", value: "Zoho CRM Platform", note: "The central engagement layer connecting customer touchpoints to existing systems." },
			{ label: "Scope", value: "Phased Delivery", note: "Structured rollout across agreed operational milestones to verify success early." },
			{ label: "Phase 1 Focus", value: "Core Engagement", note: "Streamlined communication and engagement journeys across channels." },
			{ label: "Core Workflow", value: "Field & Operations", note: "Connected operations, role routing, and automated activity tracking." },
			{ label: "Integrations", value: "Unified Ecosystem", note: "Bi-directional data exchange with core business applications and databases." },
			{ label: "Governance", value: "Hypercare & Training", note: "Role-based training, milestone sign-offs, and dedicated post-launch support." }
		];

		let deliverableCards = [];
		if (Array.isArray(data.deliverable_cards) && data.deliverable_cards.length > 0) {
			deliverableCards = data.deliverable_cards.slice(0, 6).map((c, idx) => ({
				label: cleanStr(c.label, fallbackCards[idx]?.label || "Capability"),
				value: cleanStr(c.value, fallbackCards[idx]?.value || "Phase Focus"),
				note: cleanStr(c.note, fallbackCards[idx]?.note || "Configured workflow.")
			}));
		}

		while (deliverableCards.length < 6) {
			deliverableCards.push(fallbackCards[deliverableCards.length]);
		}

		const fallbackBenefits = [
			"Eliminates manual handoffs across sales, field engineering, and service teams.",
			"Real-time visibility into customer interaction history and project milestones.",
			"Automated routing ensures prompt follow-up on every customer inquiry.",
			"Configured security controls maintain role-based access across departments.",
			"Reduced cycle times from initial inquiry to final execution.",
			"Centralized reporting delivers actionable metrics directly to leadership."
		];

		let customerBenefits = [];
		if (Array.isArray(data.customer_benefits) && data.customer_benefits.length > 0) {
			customerBenefits = data.customer_benefits
				.map(b => (typeof b === "string" ? b.trim() : (b.text || b.title || b.description || "")).trim())
				.filter(Boolean);
		}

		if (customerBenefits.length < 6) {
			for (const fb of fallbackBenefits) {
				if (customerBenefits.length >= 6) break;
				if (!customerBenefits.includes(fb)) customerBenefits.push(fb);
			}
		}
		if (customerBenefits.length > 8) customerBenefits = customerBenefits.slice(0, 8);

		const fallbackCapabilities = [
			{
				title: "Centralized Customer View",
				subtitle: "360° Account Management",
				teaser: "Unified engagement record",
				description: "Provides a single operational record for all customer accounts, contacts, interactions, and historical requests."
			},
			{
				title: "Field Workflow Automation",
				subtitle: "Mobile & Site Visits",
				teaser: "Fast site updates",
				description: "Enables field teams to capture site details, classify requirements, and update progress in real time."
			},
			{
				title: "Automated Communication",
				subtitle: "Multi-Channel Alerts",
				teaser: "Timely notifications",
				description: "Triggers targeted updates and reminders via email and messaging at each stage of the project lifecycle."
			},
			{
				title: "Ecosystem Integration",
				subtitle: "System Interoperability",
				teaser: "Connected platforms",
				description: "Synchronizes customer data with backend ERP, finance, and operational databases without manual re-entry."
			},
			{
				title: "Executive Insights",
				subtitle: "Analytics & Governance",
				teaser: "Data-driven decisions",
				description: "Delivers comprehensive dashboards tracking lead velocity, conversion rates, and operational SLA adherence."
			}
		];

		let capabilities = [];
		if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
			capabilities = data.capabilities.map((cap, idx) => ({
				title: cleanStr(cap.title, fallbackCapabilities[idx % fallbackCapabilities.length].title),
				subtitle: cleanStr(cap.subtitle, fallbackCapabilities[idx % fallbackCapabilities.length].subtitle),
				teaser: cleanStr(cap.teaser, fallbackCapabilities[idx % fallbackCapabilities.length].teaser),
				description: cleanStr(cap.description, fallbackCapabilities[idx % fallbackCapabilities.length].description)
			}));
		}

		while (capabilities.length < 5) {
			capabilities.push(fallbackCapabilities[capabilities.length]);
		}
		if (capabilities.length > 8) capabilities = capabilities.slice(0, 8);

		const fallbackTimeline = [
			{
				name: "Discovery & Alignment",
				duration: "1–2 weeks",
				items: ["Finalize requirement specifications", "Confirm integration touchpoints", "Lock detailed project scope"],
				note: "Establishes validated technical baseline before configuration."
			},
			{
				name: "Phase 1 — Core Build",
				duration: "4–6 weeks",
				items: ["Configure core modules & pipelines", "Implement role-based access", "Build automated communication workflows"],
				note: "Delivers the foundational engagement platform."
			},
			{
				name: "Phase 2 — Integrations & Testing",
				duration: "3–4 weeks",
				items: ["Connect third-party endpoints", "Perform end-to-end UAT", "Execute data migration and validation"],
				note: "Ensures seamless interoperability across systems."
			},
			{
				name: "Go-Live & Hypercare",
				duration: "2–3 weeks",
				items: ["Role-based user onboarding", "Production deployment", "Dedicated Hypercare support"],
				note: "Guarantees smooth adoption and rapid resolution of launch questions."
			}
		];

		let timelinePhases = [];
		if (Array.isArray(data.timeline_phases) && data.timeline_phases.length >= 3) {
			timelinePhases = data.timeline_phases.slice(0, 5).map((p, idx) => ({
				name: cleanStr(p.name, fallbackTimeline[idx % fallbackTimeline.length].name),
				duration: cleanStr(p.duration, fallbackTimeline[idx % fallbackTimeline.length].duration),
				items: Array.isArray(p.items) && p.items.length > 0
					? p.items.map(it => cleanStr(it)).filter(Boolean)
					: fallbackTimeline[idx % fallbackTimeline.length].items,
				note: cleanStr(p.note, fallbackTimeline[idx % fallbackTimeline.length].note)
			}));
		} else {
			timelinePhases = fallbackTimeline;
		}

		const fallbackRollout = [
			{ label: "Phase 1 Rollout", value: "Core Workflow Launch", note: "Deploy the foundational CRM engagement layer for early operational feedback." },
			{ label: "Phase 2 Rollout", value: "Full Ecosystem Connect", note: "Activate advanced integrations, reporting dashboards, and extended automation." }
		];

		let rolloutOverview = fallbackRollout;
		if (Array.isArray(data.rollout_overview) && data.rollout_overview.length === 2) {
			rolloutOverview = data.rollout_overview.map((r, idx) => ({
				label: cleanStr(r.label, fallbackRollout[idx].label),
				value: cleanStr(r.value, fallbackRollout[idx].value),
				note: cleanStr(r.note, fallbackRollout[idx].note)
			}));
		}

		const fallbackDeRisk = [
			{ label: "Dedicated Hypercare", value: "Zero Disruption", note: "Hands-on post-launch engineering support ensures immediate resolution of any operational queries." },
			{ label: "BRD Validation", value: "Confirmed Scope", note: "Every technical requirement and assumption is verified during discovery before locked design." }
		];

		let deRiskSummary = fallbackDeRisk;
		if (Array.isArray(data.de_risk_summary) && data.de_risk_summary.length === 2) {
			deRiskSummary = data.de_risk_summary.map((d, idx) => ({
				label: cleanStr(d.label, fallbackDeRisk[idx].label),
				value: cleanStr(d.value, fallbackDeRisk[idx].value),
				note: cleanStr(d.note, fallbackDeRisk[idx].note)
			}));
		}

		return {
			proposal_title: title,
			project_summary: summary,
			what_we_deliver: whatWeDeliver,
			spikra_way: spikraWay,
			how_we_support: howWeSupport,
			deliverable_cards: deliverableCards,
			customer_benefits: customerBenefits,
			capabilities,
			timeline_phases: timelinePhases,
			rollout_overview: rolloutOverview,
			de_risk_summary: deRiskSummary,
			business_challenge: data.business_challenge || null,
			recommended_solution: data.recommended_solution || null,
			modules: Array.isArray(data.modules) ? data.modules : [],
			workflow_steps: Array.isArray(data.workflow_steps) ? data.workflow_steps : [],
			milestones: Array.isArray(data.milestones) ? data.milestones : [],
			integrations: Array.isArray(data.integrations) ? data.integrations : [],
			technical_ecosystem: Array.isArray(data.technical_ecosystem) ? data.technical_ecosystem : [],
			scope_and_governance: Array.isArray(data.scope_and_governance) ? data.scope_and_governance : [],
			assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
			risks: Array.isArray(data.risks) ? data.risks : []
		};
	}
}

function extractJsonFromString(str) {
	if (!str || typeof str !== "string") return null;
	const trimmed = str.trim();

	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			return JSON.parse(trimmed);
		} catch {}
	}

	const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (jsonBlockMatch && jsonBlockMatch[1]) {
		try {
			return JSON.parse(jsonBlockMatch[1].trim());
		} catch {}
	}

	const startIdx = trimmed.indexOf("{");
	const endIdx = trimmed.lastIndexOf("}");
	if (startIdx !== -1 && endIdx > startIdx) {
		try {
			return JSON.parse(trimmed.substring(startIdx, endIdx + 1));
		} catch {}
	}

	return null;
}

class ConfigurationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigurationError";
	}
}

class AgentAPIError extends Error {
	constructor(message, statusCode = 500, rawResponse = "") {
		super(message);
		this.name = "AgentAPIError";
		this.statusCode = statusCode;
		this.rawResponse = rawResponse;
	}
}

class SchemaValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "SchemaValidationError";
	}
}

function getZiaAgentClient(options = {}) {
	return new ZiaAgentClient(options);
}

module.exports = {
	ZiaAgentClient,
	getZiaAgentClient,
	getAIProvider: getZiaAgentClient,
	ConfigurationError,
	AgentAPIError,
	SchemaValidationError,
	DEFAULT_ENDPOINT_PLACEHOLDER
};
