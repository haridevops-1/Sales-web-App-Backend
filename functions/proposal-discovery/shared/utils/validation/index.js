"use strict";

// Lightweight, dependency-free structural validation - matches Workspace 1's own style
// (shared/agent/index.js has no JSON-schema library either), so no new npm dependency
// has to be bundled into every function. Rejects malformed/empty Agent output rather
// than silently accepting it - same anti-hallucination discipline as Workspace 1's
// hasMeaningfulShowcaseContent guard.

const ZIA_RESPONSE_ARRAY_FIELDS = [
	"goals",
	"requirements",
	"pain_points",
	"existing_process",
	"proposed_solution",
	"zoho_solutions",
	"expected_outcomes"
];

function isNonEmptyString(val) {
	return typeof val === "string" && val.trim().length > 0;
}

function isStringArray(val) {
	return Array.isArray(val) && val.every((item) => typeof item === "string");
}

function normalizeZiaResponse(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const data = { ...raw };

	if (!data.customer || typeof data.customer !== "object") {
		data.customer = {
			company_name: String(data.customer_name || data.company_name || data.client_name || "Customer").trim(),
			industry: String(data.industry || "").trim(),
			business_context: String(data.business_context || data.overview || "").trim()
		};
	} else {
		data.customer = {
			company_name: String(data.customer.company_name || data.customer.name || data.customer.company || "Customer").trim(),
			industry: String(data.customer.industry || "").trim(),
			business_context: String(data.customer.business_context || data.customer.context || "").trim()
		};
	}

	for (const field of ZIA_RESPONSE_ARRAY_FIELDS) {
		const val = data[field];
		if (Array.isArray(val)) {
			data[field] = val.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object") {
					return item.title || item.name || item.text || item.description || JSON.stringify(item);
				}
				return String(item || "");
			}).filter((s) => s.trim().length > 0);
		} else if (typeof val === "string" && val.trim().length > 0) {
			data[field] = [val.trim()];
		} else {
			data[field] = [];
		}
	}

	return data;
}

// Structural check only (shape, types) - not "is this a good proposal." A structurally
// valid response with thin content is still valid; an empty/malformed one is not.
function validateZiaResponse(raw) {
	const errors = [];
	const data = normalizeZiaResponse(raw);

	// Debug: log what the validator receives
	console.log("[W2 Validation] Normalized data keys:", data ? JSON.stringify(Object.keys(data)) : "null");

	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { valid: false, errors: ["Response is not a JSON object."], normalized: null };
	}

	if (!data.customer || typeof data.customer !== "object") {
		errors.push("Missing or invalid 'customer' object.");
	} else {
		// Company name is flexible — if missing, normalization sets "Customer"
		if (typeof data.customer.industry !== "string") errors.push("customer.industry must be a string.");
		if (typeof data.customer.business_context !== "string") errors.push("customer.business_context must be a string.");
	}

	for (const field of ZIA_RESPONSE_ARRAY_FIELDS) {
		if (!Array.isArray(data[field])) {
			// Non-fatal: force it to empty array
			data[field] = [];
		} else if (!isStringArray(data[field])) {
			// Normalization should have already coerced items to strings, but log it
			console.warn(`[W2 Validation] '${field}' contains non-string items after normalization — forcing string coercion.`);
			data[field] = data[field].map(item => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object") return item.title || item.name || item.text || item.description || JSON.stringify(item);
				return String(item || "");
			}).filter(s => s.trim().length > 0);
		}
	}

	// Content gate: at least one substantive section must have data. Check both
	// string-array fields AND object-array fields (deliverables, milestones).
	const hasStringContent = ZIA_RESPONSE_ARRAY_FIELDS.some((field) => Array.isArray(data[field]) && data[field].length > 0);
	const hasDeliverables = Array.isArray(data.deliverables) && data.deliverables.length > 0;
	const hasMilestones = Array.isArray(data.implementation_milestones) && data.implementation_milestones.length > 0;
	const hasCustomerName = data.customer && isNonEmptyString(data.customer.company_name) && data.customer.company_name !== "Customer";
	const hasContext = data.customer && isNonEmptyString(data.customer.business_context);
	const hasContent = hasStringContent || hasDeliverables || hasMilestones || hasCustomerName || hasContext;

	if (errors.length === 0 && !hasContent) {
		console.warn("[W2 Validation] No content found. Array lengths:", JSON.stringify(
			ZIA_RESPONSE_ARRAY_FIELDS.reduce((acc, f) => { acc[f] = (data[f] || []).length; return acc; }, {})
		));
		errors.push("Response has no content in any section.");
	}

	return { valid: errors.length === 0, errors, normalized: data };
}

module.exports = { validateZiaResponse, normalizeZiaResponse, isNonEmptyString, isStringArray };

