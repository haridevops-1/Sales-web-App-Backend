"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_ENDPOINT_PLACEHOLDER = "[PASTE ZIA AGENT URL HERE]";
// Raised from 120s now that Function 3 runs as Advanced I/O with a much longer execution budget -
// large documents need more real Agent processing time than Basic I/O ever allowed. Override via
// ZIA_AGENT_TIMEOUT_MS if the actual Catalyst Advanced I/O ceiling turns out to need a different value.
const DEFAULT_TIMEOUT_MS = 280000;

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
			"Writing guidelines:\n" +
			"- Use simple, concise, and clear English. Avoid heavy jargon and repetitive phrasing.\n" +
			"- project_summary: 1 to 2 simple sentences explaining what the solution accomplishes (max 35 words).\n" +
			"- what_we_deliver: 1 clear sentence describing what Spikra builds/configures (max 30 words).\n" +
			"- spikra_way: 1 clear sentence describing Spikra's methodology (e.g. requirements-first, structured validation; max 30 words).\n" +
			"- how_we_support: 1 clear sentence describing hands-on training, integration, and post-go-live Hypercare (max 30 words).\n" +
			"- capabilities: Array of 5 to 7 interactive items. Each item MUST have: title, subtitle, teaser (short punchy phrase), and description (2-3 complete, informative sentences explaining what this capability does and its direct business value - description MUST NOT be empty or generic).",
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
			const schemaErr = new SchemaValidationError(
				"Zia Agent response did not contain a recognizable Customer Showcase structure " +
				"(missing proposal_title/project_summary and insufficient deliverable_cards/capabilities/customer_benefits/timeline_phases). " +
				"Refusing to substitute generic fabricated customer content."
			);
			// Diagnostic only (no secrets/document text) - a shallow shape snapshot the caller can
			// pass to context.log (console.* here is not reliably captured by Catalyst's log
			// pipeline), so the actual response shape is visible if the schema still doesn't match.
			schemaErr.rawResponseSnapshot = response_keys_safe(responseData);
			schemaErr.extractedOutputSnapshot = response_keys_safe(structuredOutput);
			throw schemaErr;
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
			// Zoho's documented Zia Agents API response shape nests the agent's generated output
			// at data.response (see the official API reference), which this extraction never
			// checked before - it only looked at a top-level "response" key.
			if (response.data.response) {
				if (typeof response.data.response === "object") {
					return response.data.response;
				}
				if (typeof response.data.response === "string") {
					const inner = extractJsonFromString(response.data.response);
					if (inner) return inner;
				}
			}
		} else if (typeof response.data === "string") {
			const inner = extractJsonFromString(response.data);
			if (inner) return inner;
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

	// Structural normalization only - never injects unrelated generic business content.
	// hasMeaningfulShowcaseContent() has already gated out empty/unusable responses before
	// this runs, so everything reaching here is real Agent output; this only enforces
	// shape (trims strings, caps array lengths, drops malformed entries) and fills a
	// missing/short field with null or an empty array rather than fabricated filler.
	normalizeShowcaseContent(data = {}, { businessName = "Spikra", projectName = "Customer Proposal", text = "" }) {
		const cleanStr = (val) => {
			if (typeof val !== "string" || !val.trim() || val.trim().toLowerCase() === "not specified in the source document") {
				return null;
			}
			return val.trim();
		};

		const title = cleanStr(data.proposal_title && data.proposal_title.length <= 80 ? data.proposal_title : null) ||
			cleanStr(projectName !== "Customer Proposal" ? projectName : null);
		const summary = cleanStr(data.project_summary);
		const whatWeDeliver = cleanStr(data.what_we_deliver);
		const spikraWay = cleanStr(data.spikra_way);
		const howWeSupport = cleanStr(data.how_we_support);

		let deliverableCards = [];
		if (Array.isArray(data.deliverable_cards)) {
			deliverableCards = data.deliverable_cards
				.map((c) => ({ label: cleanStr(c && c.label), value: cleanStr(c && c.value), note: cleanStr(c && c.note) }))
				.filter((c) => c.label || c.value || c.note)
				.slice(0, 6);
		}

		let customerBenefits = [];
		if (Array.isArray(data.customer_benefits)) {
			customerBenefits = data.customer_benefits
				.map((b) => cleanStr(typeof b === "string" ? b : (b && (b.text || b.title || b.description))))
				.filter(Boolean)
				.slice(0, 8);
		}

		let capabilities = [];
		if (Array.isArray(data.capabilities)) {
			capabilities = data.capabilities
				.map((cap) => ({
					title: cleanStr(cap && cap.title),
					subtitle: cleanStr(cap && cap.subtitle),
					teaser: cleanStr(cap && cap.teaser),
					description: cleanStr(cap && cap.description)
				}))
				.filter((c) => c.title || c.description)
				.slice(0, 8);
		}

		let timelinePhases = [];
		if (Array.isArray(data.timeline_phases)) {
			timelinePhases = data.timeline_phases
				.map((p) => ({
					name: cleanStr(p && p.name),
					duration: cleanStr(p && p.duration),
					items: Array.isArray(p && p.items) ? p.items.map(cleanStr).filter(Boolean) : [],
					note: cleanStr(p && p.note)
				}))
				.filter((p) => p.name || p.items.length > 0)
				.slice(0, 5);
		}

		let rolloutOverview = [];
		if (Array.isArray(data.rollout_overview) && data.rollout_overview.length === 2) {
			rolloutOverview = data.rollout_overview.map((r) => ({
				label: cleanStr(r && r.label), value: cleanStr(r && r.value), note: cleanStr(r && r.note)
			}));
		}

		let deRiskSummary = [];
		if (Array.isArray(data.de_risk_summary) && data.de_risk_summary.length === 2) {
			deRiskSummary = data.de_risk_summary.map((d) => ({
				label: cleanStr(d && d.label), value: cleanStr(d && d.value), note: cleanStr(d && d.note)
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

// Shallow, size-bounded snapshot of an object's shape for diagnostic logging - never dumps
// full document text or large arrays, just enough structure to see what came back.
function response_keys_safe(obj, depth = 0) {
	if (obj === null || obj === undefined) return obj;
	if (depth >= 2 || typeof obj !== "object") {
		if (typeof obj === "string") return obj.length > 120 ? `${obj.slice(0, 120)}...(${obj.length} chars)` : obj;
		return obj;
	}
	if (Array.isArray(obj)) {
		return `Array(${obj.length})`;
	}
	const snapshot = {};
	for (const key of Object.keys(obj).slice(0, 20)) {
		snapshot[key] = response_keys_safe(obj[key], depth + 1);
	}
	return snapshot;
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
