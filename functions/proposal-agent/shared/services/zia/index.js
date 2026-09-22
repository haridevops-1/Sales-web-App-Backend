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
		"Analyze the following consolidated customer discovery content (from documents, MOM, and notes) and generate structured proposal content. Do a single pass - do not plan or use multiple reasoning steps.",
		"Ground every field in the content below. Never invent customer facts, requirements, pain points, systems, or decisions. Use an empty array where the content genuinely doesn't cover a section.",
		'Return ONLY this JSON object, no markdown, no wrapper key: { "customer": {"company_name","industry","business_context"}, "goals": [], "requirements": [], "pain_points": [], "existing_process": [], "proposed_solution": [], "zoho_solutions": [], "expected_outcomes": [] }',
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

// Only returns a value if the raw response actually contains usage data under one of
// these commonly-used field names - otherwise null. Never fabricated (Section 14).
function extractUsage(response) {
	if (!response || typeof response !== "object") return null;
	const candidates = [response.usage, response.data && response.data.usage, response.token_usage];
	const usage = candidates.find((c) => c && typeof c === "object");
	if (!usage) return null;

	const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
	const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? null;
	if (inputTokens === null && outputTokens === null) return null;

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: usage.total_tokens ?? (typeof inputTokens === "number" && typeof outputTokens === "number" ? inputTokens + outputTokens : null)
	};
}

function extractStructuredData(response) {
	if (!response || typeof response !== "object") {
		throw new ProposalError("INVALID_ZIA_RESPONSE", "Zia Agent returned an invalid response structure.");
	}
	if (response.customer || response.goals || response.requirements) return response;
	if (response.data && typeof response.data === "object") {
		if (response.data.customer || response.data.goals) return response.data;
		if (response.data.response) {
			if (typeof response.data.response === "object") return response.data.response;
			if (typeof response.data.response === "string") {
				const inner = extractJsonFromString(response.data.response);
				if (inner) return inner;
			}
		}
	}
	if (typeof response.output === "string") {
		const inner = extractJsonFromString(response.output);
		if (inner) return inner;
	}
	return response;
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
