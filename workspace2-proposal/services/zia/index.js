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

	async generateProposal(discoveryText, { businessName, industry } = {}, connectionCredentials) {
		if (!discoveryText || typeof discoveryText !== "string" || !discoveryText.trim()) {
			throw new ProposalError("VALIDATION_FAILED", "Discovery content is empty - nothing to send to the Zia Agent.");
		}
		if (!this.isConfigured()) {
			throw new ProposalError(
				"ZIA_AGENT_FAILED",
				"Workspace 2 Zia Agent endpoint is not configured (PROPOSAL_ZIA_AGENT_ENDPOINT)."
			);
		}

		const query = buildQuery(discoveryText, { businessName, industry });
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

function buildQuery(discoveryText, { businessName, industry }) {
	const context = [
		businessName ? `Customer: ${businessName}` : null,
		industry ? `Industry: ${industry}` : null
	].filter(Boolean).join("\n");

	return [
		context,
		"You are the Solution Proposal Agent for Spikra. Analyze the following consolidated customer discovery content (from documents, MOM, and notes) and generate comprehensive structured proposal content. Do a single pass - do not plan or use multiple reasoning steps.",
		"Ground every field in the content below. Never invent customer facts, requirements, pain points, systems, or decisions. If a section is not mentioned, use an empty array or null.",
		'Return ONLY this JSON object, no markdown, no wrapper key:\n{\n  "customer": {"company_name": "", "industry": "", "business_context": ""},\n  "goals": [],\n  "requirements": [],\n  "pain_points": [],\n  "existing_process": [],\n  "proposed_solution": [],\n  "zoho_solutions": [],\n  "expected_outcomes": [],\n  "deliverables": [{"title": "", "description": "", "scope": ""}],\n  "implementation_milestones": [{"phase_name": "", "timeline": "", "milestones": ""}],\n  "license_cost_info": null,\n  "payment_terms": null,\n  "assumptions": [],\n  "support_hypercare": null\n}',
		"Discovery content:",
		discoveryText.trim()
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

function extractStructuredData(response) {
	if (!response || typeof response !== "object") {
		throw new ProposalError("INVALID_ZIA_RESPONSE", "Zia Agent returned an invalid response structure.");
	}

	// Comprehensive extraction: check every path the Zia Agent Trigger API might use
	// (mirrors Workspace 1's proven _extractStructuredData logic).
	let target = response;

	if (response.customer || response.goals || response.requirements) {
		target = response;
	} else if (response.data && typeof response.data === "object") {
		if (response.data.customer || response.data.goals || response.data.requirements) {
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
	const customer = target.customer && typeof target.customer === "object" ? target.customer : {};
	return {
		customer: {
			company_name: String(customer.company_name || target.company_name || target.customer_name || "").trim(),
			industry: String(customer.industry || target.industry || "").trim(),
			business_context: String(customer.business_context || target.business_context || target.overview || "").trim()
		},
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
