"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_ENDPOINT_PLACEHOLDER = "[PASTE ZIA AGENT URL HERE]";
// Raised from 120s now that Function 3 runs as Advanced I/O with a much longer execution budget -
// large documents need more real Agent processing time than Basic I/O ever allowed. Override via
// ZIA_AGENT_TIMEOUT_MS if the actual Catalyst Advanced I/O ceiling turns out to need a different value.
const DEFAULT_TIMEOUT_MS = 280000;
// The full document text is sent to the agent - nothing is dropped. Set ZIA_MAX_INPUT_CHARS only if
// you ever need a hard limit; by default there is none.
const MAX_INPUT_CHARS = Number(process.env.ZIA_MAX_INPUT_CHARS) > 0 ? Number(process.env.ZIA_MAX_INPUT_CHARS) : Infinity;

function limitDocumentText(text) {
	const body = String(text).trim();
	if (body.length <= MAX_INPUT_CHARS) return body;
	const head = Math.floor(MAX_INPUT_CHARS * 0.6);
	const tail = MAX_INPUT_CHARS - head;
	return `${body.slice(0, head).trim()}\n\n[... middle of the document omitted for length ...]\n\n${body.slice(body.length - tail).trim()}`;
}

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
			"Coverage (most important):\n" +
			"- Read the WHOLE document, section by section, however long it is. Every major module, workflow, integration, user group, phase, dependency, assumption and risk the document discusses must appear somewhere in the output. Do not skip parts because the document is long, and do not shrink real content to a one-line summary.\n" +
			"- Use only what the document says. Never invent facts, numbers, names, systems or timelines.",
			"Writing style:\n" +
			"- Write for a business owner with no technical background, in plain everyday words (layman's terms), in short clear sentences.\n" +
			"- Avoid jargon, product code names, acronyms and technical terms. If a tool or term cannot be avoided, add a few plain words about what it does for the business. Spell out acronyms the first time.\n" +
			"- Explain what each item means for the customer: what changes, who uses it, how it works step by step in simple words, and what the customer gets. Do not repeat the same phrasing.",
			"Depth (each field must be as full as the document supports, not one or two lines):\n" +
			"- project_summary: 3 to 5 sentences. what_we_deliver, spikra_way, how_we_support: 2 to 3 sentences each.\n" +
			"- deliverable_cards: the main parts of the solution, 3 to 9 cards (use 3, 6 or 9 so the rows are even; usually 6); label 2-4 words, value up to 6 words, note 1 to 2 sentences.\n" +
			"- customer_benefits: 8 to 12 items, each 1 to 2 sentences.\n" +
			"- capabilities: 8 to 12 items, one per major area of the document. title, subtitle and teaser are short; description is 4 to 6 sentences naming the real systems, steps, rules and users from the document.\n" +
			"- timeline_phases: 3 to 6 phases, each with 5 to 8 bullet items and a note of 1 to 2 sentences.\n" +
			"- rollout_overview: 2 to 4 cards on how the rollout is staged, and de_risk_summary: 2 to 4 cards on how the risks are handled (prefer an even number); label 2-4 words, value up to 6 words, note 1 to 2 sentences. Take the card titles and content from this document; do not reuse fixed titles from other projects.\n" +
			"- The number of items in every list follows the document: more content means more items. Never invent items to reach a number, and never leave real content out to stay under one.",
			"Highlighting:\n" +
			"- In sentences and paragraphs only, wrap the 2 to 4 most important words or short phrases in **double asterisks**: names of systems or modules, key numbers and durations, and key outcomes. Never wrap a whole sentence or ordinary words. Do not use asterisks anywhere else, and never in titles, labels, values, subtitles, teasers, phase names or durations.",
			"Return ONLY a single JSON object (no markdown, no prose) with fields: proposal_title, project_summary, what_we_deliver, spikra_way, how_we_support, deliverable_cards (array of 3 to 9 {label,value,note}), customer_benefits (array of strings), capabilities (array of {title,subtitle,teaser,description}), timeline_phases (array of {name,duration,items[],note}), rollout_overview (array of 2 to 4 {label,value,note}), de_risk_summary (array of 2 to 4 {label,value,note}).",
			"Document content:",
			limitDocumentText(text)
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
				.slice(0, 9);
		}

		let customerBenefits = [];
		if (Array.isArray(data.customer_benefits)) {
			customerBenefits = data.customer_benefits
				.map((b) => cleanStr(typeof b === "string" ? b : (b && (b.text || b.title || b.description))))
				.filter(Boolean)
				.slice(0, 12);
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
				.slice(0, 12);
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
				.slice(0, 6);
		}

		let rolloutOverview = [];
		if (Array.isArray(data.rollout_overview)) {
			rolloutOverview = data.rollout_overview
				.map((r) => ({ label: cleanStr(r && r.label), value: cleanStr(r && r.value), note: cleanStr(r && r.note) }))
				.filter((r) => r.label || r.value || r.note)
				.slice(0, 4);
		}

		let deRiskSummary = [];
		if (Array.isArray(data.de_risk_summary)) {
			deRiskSummary = data.de_risk_summary
				.map((d) => ({ label: cleanStr(d && d.label), value: cleanStr(d && d.value), note: cleanStr(d && d.note) }))
				.filter((d) => d.label || d.value || d.note)
				.slice(0, 4);
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
	// Some models print their reasoning first in <think>...</think>; it can contain braces that
	// would break the brace-matching fallback below, so drop it before looking for the JSON.
	const trimmed = str.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();

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
