"use strict";

// Client for the EXISTING Workspace 2 Zia Agent (proposal generation). Deliberately
// mirrors shared/agent/index.js's proven request/response contract for Workspace 1's
// Zia Agent - same platform, same trigger API, same Connection-based auth - rather than
// guessing a new shape. Model choice (GLM 4.7 Flash vs Venn) is configured in Zia Agent
// Studio, never hardcoded here (see Section 10 of the spec).

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { ProposalError } = require("../../utils/errors");

const DEFAULT_TIMEOUT_MS = 280000;

class ProposalZiaAgentClient {
	constructor(config = {}) {
		const rawEndpoint = config.endpoint || process.env.PROPOSAL_ZIA_AGENT_ENDPOINT || "https://agents.zoho.com/ziaagents/api/v1/agents/3266000000166001/trigger";
		this.endpoint = String(rawEndpoint).trim();
		this.connectionLinkName = String(
			config.connectionLinkName || process.env.PROPOSAL_ZIA_CONNECTION_LINK_NAME || "internalsaleshub"
		).trim();
		this.timeoutMs = Number(config.timeoutMs || process.env.PROPOSAL_ZIA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
		this.lastSessionId = null;
		this.lastModel = null;
		// Populated only if the raw response actually contains usage data - never invented.
		// See utils around AI_USAGE_LOG: null fields mean "not returned," not "zero."
		this.lastUsage = null;
	}

	isConfigured() {
		return Boolean(this.endpoint);
	}

	async generateProposal(discoveryInput, { businessName, industry } = {}, connectionCredentials, rawSourceText) {
		const discoveryText = typeof discoveryInput === "object"
			? JSON.stringify(discoveryInput, null, 2)
			: String(discoveryInput || "").trim();

		if (!discoveryText) {
			throw new ProposalError("VALIDATION_FAILED", "Discovery content is empty - nothing to send to the Zia Agent.");
		}
		if (!this.isConfigured()) {
			throw new ProposalError(
				"ZIA_AGENT_FAILED",
				"Workspace 2 Zia Agent endpoint is not configured (PROPOSAL_ZIA_AGENT_ENDPOINT)."
			);
		}

		const query = buildQuery(discoveryText, { businessName, industry }, rawSourceText);
		const payload = { query, systemArgs: {}, reasoning: false, attachments: [] };

		const responseData = await this._callAgentEndpoint(payload, connectionCredentials);
		this.lastSessionId = extractSessionId(responseData);
		this.lastModel = extractModelName(responseData);
		this.lastUsage = extractUsage(responseData);

		return extractStructuredData(responseData);
	}

	async _callAgentEndpoint(payload, connectionCredentials) {
		const urlObj = new URL(this.endpoint);
		const payloadString = JSON.stringify(payload);
		const isHttps = urlObj.protocol === "https:";
		const client = isHttps ? https : http;

		const headers = {
			"Content-Type": "application/json; charset=utf-8",
			Accept: "application/json, text/plain, */*",
			...(connectionCredentials && connectionCredentials.headers ? connectionCredentials.headers : {})
		};
		const authToken = process.env.PROPOSAL_ZIA_AUTH_TOKEN || process.env.ZIA_AGENT_AUTH_TOKEN || "";
		if (!headers["Authorization"] && authToken) {
			headers["Authorization"] = `Zoho-oauthtoken ${authToken.trim()}`;
		}
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
				res.on("data", (chunk) => { rawData += chunk; });
				res.on("end", () => {
					const statusCode = res.statusCode || 200;
					if (statusCode < 200 || statusCode >= 300) {
						return reject(
							new ProposalError("ZIA_AGENT_FAILED", `Zia Agent returned HTTP ${statusCode}: ${rawData.slice(0, 500)}`)
						);
					}
					if (!rawData || !rawData.trim()) {
						return reject(new ProposalError("ZIA_AGENT_FAILED", "Zia Agent returned an empty response body."));
					}
					try {
						resolve(JSON.parse(rawData));
					} catch {
						const inner = extractJsonFromString(rawData);
						if (inner) return resolve(inner);
						reject(new ProposalError("ZIA_AGENT_FAILED", `Zia Agent returned a non-JSON response: ${rawData.slice(0, 300)}`));
					}
				});
			});

			req.on("timeout", () => {
				req.destroy();
				reject(new ProposalError("TIMEOUT", `Zia Agent request timed out after ${this.timeoutMs}ms.`));
			});
			req.on("error", (err) => {
				reject(new ProposalError("ZIA_AGENT_FAILED", `Failed to connect to the Zia Agent endpoint: ${err.message}`));
			});

			req.write(payloadString);
			req.end();
		});
	}
}

function buildQuery(consolidatedJsonString, { businessName, industry }, rawSourceText) {
	const customerName = businessName ? `Customer: ${businessName}` : "";
	const ind = industry ? `Industry: ${industry}` : "";
	const context = [customerName, ind].filter(Boolean).join("\n");
	const hasRawSource = typeof rawSourceText === "string" && rawSourceText.trim().length > 0;

	return [
		context,
		"You are the Customer Proposal Generation Agent for Spikra. You are given the actual uploaded discovery documents (verbatim text) below, plus a pre-classified summary of them. Read the real documents yourself rather than relying only on the summary - the summary is a convenience aid and can miss or flatten details (pricing tables, SLA wording, specific technical requirements) that are present in the real text. From that source material, generate THREE separate, independent documents:",
		"1. technical_document: ONLY technical content - architecture, systems, functional & technical requirements, integrations, technical deliverables. Do not include pricing, payment terms, or legal/SLA commitments here.",
		"2. commercial_document: ONLY commercial content - executive summary, scope of work, deliverables catalog, implementation milestones/timeline, and pricing/licensing/payment terms. Pull any actual pricing figures, cost breakdowns, payment schedules, or licensing costs that appear anywhere in the source documents into this document - do not discard them. Do not include technical architecture detail or TOS/legal clauses here.",
		"3. tos_document: ONLY terms-of-service content - scope governance, assumptions, dependencies, risks, SLA, support/hypercare, and any legal or contractual terms found in the source documents. Do not include technical architecture or pricing detail here.",
		"",
		"SEPARATION RULE: each document is read on its own by the client and must stand alone - never repeat a fact that belongs in one document inside another (e.g. a price figure belongs only in commercial_document, an SLA response time belongs only in tos_document, an integration list belongs only in technical_document).",
		"",
		"GROUNDING RULES:",
		"- Every fact in every document must come from the source documents below (verbatim text) or the pre-classified summary - never invent customer information, pricing, payment terms, timelines, or legal/TOS commitments.",
		"- If a document genuinely contains no commercial or TOS detail at all, say so plainly (e.g. \"subject to mutual commercial alignment\") instead of inventing numbers - but check the real source text first, since these details are often present in a table or a section the summary didn't capture.",
		"- The document generator applies the visual presentation templates. Do NOT generate HTML, CSS, JavaScript or visual UI.",
		"",
		"Return ONLY a valid JSON object matching this exact structure, with no markdown code blocks, no backticks, and no wrapper key:",
		'{\n  "technical_document": {\n    "title": "Technical Document",\n    "sections": [\n      {\n        "heading": "Architecture & System Blueprint",\n        "content": "...",\n        "subsections": [\n          { "title": "Key Technical Requirements", "content": "..." }\n        ]\n      }\n    ]\n  },\n  "commercial_document": {\n    "title": "Commercial Proposal",\n    "sections": [\n      {\n        "heading": "Executive Summary & Commercial Scope",\n        "content": "...",\n        "subsections": [\n          { "title": "Deliverables & Modules", "content": "..." }\n        ]\n      }\n    ]\n  },\n  "tos_document": {\n    "title": "TOS Document",\n    "sections": [\n      {\n        "heading": "Scope Governance & Terms of Service",\n        "content": "...",\n        "subsections": [\n          { "title": "Key Assumptions & Responsibilities", "content": "..." }\n        ]\n      }\n    ]\n  }\n}',
		"",
		"Pre-classified summary (Consolidated Customer JSON):",
		consolidatedJsonString.trim(),
		hasRawSource ? "Actual uploaded discovery documents (verbatim text - this is the source of truth):" : "",
		hasRawSource ? rawSourceText.trim() : ""
	].filter(Boolean).join("\n\n");
}

function extractSessionId(response) {
	if (!response || typeof response !== "object") return null;
	const candidate = response.session_id || response.sessionId ||
		(response.data && (response.data.session_id || response.data.sessionId));
	return candidate ? String(candidate).trim() : null;
}

// Real model name/id as reported by the Agent response, if present - otherwise null.
// Used for per-model token accounting (W2_AI_USAGE_LOG.model_name); never guessed.
function extractModelName(response) {
	if (!response || typeof response !== "object") return null;
	const candidates = [
		response.model,
		response.model_name,
		response.agent_name,
		response.agentName,
		response.data && response.data.model,
		response.data && response.data.model_name,
		response.data && response.data.agent_name,
		response.data && response.data.agentName
	];
	const found = candidates.find((c) => typeof c === "string" && c.trim());
	return found ? found.trim() : null;
}

// Only returns a value if the raw response actually contains usage data under one of
// these commonly-used field names - otherwise null. Never fabricated (Section 14).
function extractUsage(response) {
	if (!response || typeof response !== "object") return null;
	const candidates = [
		response.usage,
		response.data && response.data.usage,
		response.token_usage,
		response.tokens,
		response.data && response.data.tokens,
		response.metrics
	];
	const usage = candidates.find((c) => c && typeof c === "object");
	if (!usage) return null;

	const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
	const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? null;
	if (inputTokens === null && outputTokens === null) return null;

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: usage.total_tokens ?? usage.totalTokens ??
			(typeof inputTokens === "number" && typeof outputTokens === "number" ? inputTokens + outputTokens : null)
	};
}

function normalizeDocumentSection(sec, defaultHeading) {
	if (!sec) return { heading: defaultHeading, content: "", subsections: [] };
	if (typeof sec === "string") {
		return { heading: defaultHeading, content: sec, subsections: [] };
	}
	const heading = String(sec.heading || sec.title || defaultHeading).trim();
	const content = String(sec.content || sec.description || sec.text || sec.summary || "").trim();
	const rawSubs = Array.isArray(sec.subsections) ? sec.subsections : [];
	const subsections = rawSubs.map((sub, idx) => {
		if (typeof sub === "string") return { title: `Item ${idx + 1}`, content: sub };
		if (sub && typeof sub === "object") {
			return {
				title: String(sub.title || sub.heading || sub.name || `Item ${idx + 1}`).trim(),
				content: String(sub.content || sub.description || sub.scope || sub.text || "").trim()
			};
		}
		return { title: `Item ${idx + 1}`, content: String(sub || "") };
	}).filter((s) => s.title || s.content);

	return { heading, content, subsections };
}

function normalizeDocumentBlock(docObj, defaultTitle) {
	if (!docObj || typeof docObj !== "object") {
		return { title: defaultTitle, sections: [] };
	}
	const title = String(docObj.title || docObj.name || defaultTitle).trim();
	const rawSections = Array.isArray(docObj.sections) ? docObj.sections : [];
	const sections = rawSections.map((sec, idx) => normalizeDocumentSection(sec, `Section ${idx + 1}`));
	return { title, sections };
}

function synthesizeDocumentsFromLegacy(target, companyName) {
	const customerName = companyName || "Customer Organization";

	const technicalSections = [];
	if (target.business_context || (target.customer && target.customer.business_context)) {
		technicalSections.push({
			heading: "Business Context & Technical Objectives",
			content: String(target.business_context || target.customer?.business_context || ""),
			subsections: Array.isArray(target.goals) ? target.goals.map((g, i) => ({ title: `Objective ${i + 1}`, content: String(g) })) : []
		});
	}
	if (Array.isArray(target.requirements) && target.requirements.length > 0) {
		technicalSections.push({
			heading: "Functional & Technical Requirements",
			content: "System requirements scoped directly from customer discovery.",
			subsections: target.requirements.map((r, i) => ({ title: `Requirement ${i + 1}`, content: String(r) }))
		});
	}
	if (Array.isArray(target.proposed_solution) && target.proposed_solution.length > 0) {
		technicalSections.push({
			heading: "System Architecture & Proposed Platform Configuration",
			content: "Architecture and system capabilities mapped to customer workflows.",
			subsections: target.proposed_solution.map((s, i) => ({ title: `Architecture Component ${i + 1}`, content: String(s) }))
		});
	}
	if (Array.isArray(target.zoho_solutions) && target.zoho_solutions.length > 0) {
		technicalSections.push({
			heading: "Zoho Application Stack & Integrations",
			content: "Configured Zoho applications and integration landscape.",
			subsections: target.zoho_solutions.map((z) => ({ title: String(z), content: `Integrated component of the Spikra solution for ${customerName}.` }))
		});
	}
	if (Array.isArray(target.deliverables) && target.deliverables.length > 0) {
		technicalSections.push({
			heading: "Technical Scope & Deliverables",
			content: "Key technical work products and implementation packages.",
			subsections: target.deliverables.map((d, i) => ({
				title: typeof d === "object" && d.title ? d.title : `Deliverable ${i + 1}`,
				content: typeof d === "object" ? `${d.description || ""}${d.scope ? ` (Scope: ${d.scope})` : ""}` : String(d)
			}))
		});
	}

	const commercialSections = [];
	commercialSections.push({
		heading: "Executive Summary & Commercial Engagement Scope",
		content: `Commercial proposal prepared exclusively for ${customerName}. Covers end-to-end implementation scope, deliverables catalog, milestone roadmap, and commercial governance.`,
		subsections: Array.isArray(target.expected_outcomes) ? target.expected_outcomes.map((o, i) => ({ title: `Expected Outcome ${i + 1}`, content: String(o) })) : []
	});
	if (Array.isArray(target.deliverables) && target.deliverables.length > 0) {
		commercialSections.push({
			heading: "Scope of Work & Deliverables Catalog",
			content: "Structured deliverables catalog scoped strictly from discovery requirements.",
			subsections: target.deliverables.map((d, i) => ({
				title: typeof d === "object" && d.title ? d.title : `Module ${i + 1}`,
				content: typeof d === "object" ? (d.description || d.scope || JSON.stringify(d)) : String(d)
			}))
		});
	}
	if (Array.isArray(target.implementation_milestones) && target.implementation_milestones.length > 0) {
		commercialSections.push({
			heading: "Implementation Roadmap & Phased Timeline",
			content: "Execution timeline structured into transparent milestones.",
			subsections: target.implementation_milestones.map((m, i) => ({
				title: typeof m === "object" ? `${m.phase_name || `Phase ${i + 1}`}${m.timeline ? ` (${m.timeline})` : ""}` : `Phase ${i + 1}`,
				content: typeof m === "object" ? (m.milestones || m.description || "") : String(m)
			}))
		});
	}
	commercialSections.push({
		heading: "Licensing Structure, Investment & Payment Terms",
		content: "Commercial terms and payment milestone structure.",
		subsections: [
			{
				title: "Licensing & Investment Notes",
				content: target.license_cost_info ? (typeof target.license_cost_info === "object" ? JSON.stringify(target.license_cost_info) : String(target.license_cost_info)) : "To be confirmed during mutual commercial alignment."
			},
			{
				title: "Payment Milestones",
				content: target.payment_terms ? (typeof target.payment_terms === "object" ? JSON.stringify(target.payment_terms) : String(target.payment_terms)) : "Milestone-based billing upon formal sign-off of deliverables."
			}
		]
	});

	const tosSections = [];
	tosSections.push({
		heading: "Scope Governance & Engagement Terms",
		content: "Master service agreement governance, change control, and acceptance standards.",
		subsections: [
			{ title: "Governance Model", content: "Dedicated project lead, single point of contact (SPOC), and weekly status reviews." },
			{ title: "Change Management", content: "Any scope adjustments outside agreed deliverables will be governed via standard Change Request procedure." }
		]
	});
	if (Array.isArray(target.assumptions) && target.assumptions.length > 0) {
		tosSections.push({
			heading: "Project Assumptions & Client Dependencies",
			content: "Prerequisites and operational assumptions baseline for project success.",
			subsections: target.assumptions.map((a, i) => ({ title: `Assumption ${i + 1}`, content: String(a) }))
		});
	}
	tosSections.push({
		heading: "Service Level Agreement (SLA) & Hypercare Support",
		content: "Warranty and post go-live operational support.",
		subsections: [
			{
				title: "Hypercare & Warranty",
				content: target.support_hypercare ? (typeof target.support_hypercare === "object" ? JSON.stringify(target.support_hypercare) : String(target.support_hypercare)) : "Includes dedicated 30-day Hypercare post go-live with bug-fix warranty and transition handover."
			},
			{
				title: "Severity Levels & Response Times",
				content: "Critical (Severity 1): 2 hours response. High (Severity 2): 4 hours response. Normal (Severity 3): 1 business day response."
			}
		]
	});

	return {
		technical_document: {
			title: `${customerName} — Technical Specification`,
			sections: technicalSections
		},
		commercial_document: {
			title: `${customerName} — Commercial Proposal`,
			sections: commercialSections
		},
		tos_document: {
			title: `${customerName} — Terms of Service & SLA`,
			sections: tosSections
		}
	};
}

function extractStructuredData(response) {
	if (!response || typeof response !== "object") {
		throw new ProposalError("INVALID_ZIA_RESPONSE", "Zia Agent returned an invalid response structure.");
	}

	// Comprehensive extraction: check every path the Zia Agent Trigger API might use
	let target = response;

	if (response.technical_document || response.commercial_document || response.tos_document || response.customer || response.goals || response.requirements) {
		target = response;
	} else if (response.data && typeof response.data === "object") {
		if (response.data.technical_document || response.data.commercial_document || response.data.tos_document || response.data.customer || response.data.goals || response.data.requirements) {
			target = response.data;
		} else if (response.data.response) {
			if (typeof response.data.response === "object") {
				target = response.data.response;
			} else if (typeof response.data.response === "string") {
				const inner = extractJsonFromString(response.data.response);
				if (inner) target = inner;
			}
		}
	} else if (typeof response.data === "string") {
		const inner = extractJsonFromString(response.data);
		if (inner) target = inner;
	}

	if (target === response && response.output) {
		if (typeof response.output === "object") {
			target = response.output;
		} else if (typeof response.output === "string") {
			const inner = extractJsonFromString(response.output);
			if (inner) target = inner;
		}
	}

	if (target === response && response.response) {
		if (typeof response.response === "object") {
			target = response.response;
		} else if (typeof response.response === "string") {
			const inner = extractJsonFromString(response.response);
			if (inner) target = inner;
		}
	}

	if (target === response && response.result) {
		if (typeof response.result === "object") {
			target = response.result;
		} else if (typeof response.result === "string") {
			const inner = extractJsonFromString(response.result);
			if (inner) target = inner;
		}
	}

	if (target === response && response.message && typeof response.message === "string") {
		const inner = extractJsonFromString(response.message);
		if (inner) target = inner;
	}

	if (target === response && response.text && typeof response.text === "string") {
		const inner = extractJsonFromString(response.text);
		if (inner) target = inner;
	}

	if (target === response && response.content) {
		if (typeof response.content === "object") {
			target = response.content;
		} else if (typeof response.content === "string") {
			const inner = extractJsonFromString(response.content);
			if (inner) target = inner;
		}
	}

	// Normalize customer fields
	const rawCustomer = target.customer && typeof target.customer === "object" ? target.customer : {};
	const customer = {
		company_name: String(rawCustomer.company_name || rawCustomer.name || target.company_name || target.customer_name || "Customer Organization").trim(),
		industry: String(rawCustomer.industry || target.industry || "").trim(),
		business_context: String(rawCustomer.business_context || target.business_context || target.overview || "").trim()
	};

	let technical_document;
	let commercial_document;
	let tos_document;

	const hasDirectDocs = Boolean(target.technical_document || target.commercial_document || target.tos_document);

	if (hasDirectDocs) {
		technical_document = normalizeDocumentBlock(target.technical_document, `${customer.company_name} — Technical Specification`);
		commercial_document = normalizeDocumentBlock(target.commercial_document, `${customer.company_name} — Commercial Proposal`);
		tos_document = normalizeDocumentBlock(target.tos_document, `${customer.company_name} — Terms of Service & SLA`);
	} else {
		// Synthesize the 3 structured documents from legacy response shape
		const synthesized = synthesizeDocumentsFromLegacy(target, customer.company_name);
		technical_document = synthesized.technical_document;
		commercial_document = synthesized.commercial_document;
		tos_document = synthesized.tos_document;
	}

	return {
		technical_document,
		commercial_document,
		tos_document,
		customer,
		// Retain legacy fields for backward compatibility
		goals: Array.isArray(target.goals) ? target.goals : [],
		requirements: Array.isArray(target.requirements) ? target.requirements : [],
		pain_points: Array.isArray(target.pain_points) ? target.pain_points : [],
		existing_process: Array.isArray(target.existing_process) ? target.existing_process : [],
		proposed_solution: Array.isArray(target.proposed_solution) ? target.proposed_solution : [],
		zoho_solutions: Array.isArray(target.zoho_solutions) ? target.zoho_solutions : [],
		expected_outcomes: Array.isArray(target.expected_outcomes) ? target.expected_outcomes : [],
		deliverables: Array.isArray(target.deliverables) ? target.deliverables : [],
		implementation_milestones: Array.isArray(target.implementation_milestones) ? target.implementation_milestones : [],
		license_cost_info: target.license_cost_info || null,
		payment_terms: target.payment_terms || null,
		assumptions: Array.isArray(target.assumptions) ? target.assumptions : [],
		support_hypercare: target.support_hypercare || null
	};
}

function extractJsonFromString(str) {
	if (!str || typeof str !== "string") return null;
	const trimmed = str.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}"))) {
		try { return JSON.parse(trimmed); } catch {}
	}
	const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (jsonBlockMatch && jsonBlockMatch[1]) {
		try { return JSON.parse(jsonBlockMatch[1].trim()); } catch {}
	}
	const startIdx = trimmed.indexOf("{");
	const endIdx = trimmed.lastIndexOf("}");
	if (startIdx !== -1 && endIdx > startIdx) {
		try { return JSON.parse(trimmed.substring(startIdx, endIdx + 1)); } catch {}
	}
	return null;
}

function getProposalZiaAgentClient(options = {}) {
	return new ProposalZiaAgentClient(options);
}

module.exports = { ProposalZiaAgentClient, getProposalZiaAgentClient };
