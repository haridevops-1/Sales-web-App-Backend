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

	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { valid: false, errors: ["Response is not a JSON object."], normalized: null };
	}

	if (!data.customer || typeof data.customer !== "object") {
		errors.push("Missing or invalid 'customer' object.");
	} else {
		// Company name is flexible - normalizeZiaResponse() already defaults it to
		// "Customer" when absent, so it's never actually missing by this point.
		if (typeof data.customer.industry !== "string") errors.push("customer.industry must be a string.");
		if (typeof data.customer.business_context !== "string") errors.push("customer.business_context must be a string.");
	}

	for (const field of ZIA_RESPONSE_ARRAY_FIELDS) {
		if (!Array.isArray(data[field])) {
			data[field] = [];
		} else if (!isStringArray(data[field])) {
			data[field] = data[field]
				.map((item) => {
					if (typeof item === "string") return item;
					if (item && typeof item === "object") return item.title || item.name || item.text || item.description || JSON.stringify(item);
					return String(item || "");
				})
				.filter((s) => s.trim().length > 0);
		}
	}

	// At least one substantive section - mirrors Workspace 1's minimum-content gate so a
	// near-empty response is rejected rather than stored as a "successful" proposal. Checks
	// both string-array fields and object-array fields (deliverables, milestones), plus a
	// real (non-default) customer name/context, since a response can be substantive without
	// populating every array field.
	const hasStringContent = ZIA_RESPONSE_ARRAY_FIELDS.some((field) => Array.isArray(data[field]) && data[field].length > 0);
	const hasDeliverables = Array.isArray(data.deliverables) && data.deliverables.length > 0;
	const hasMilestones = Array.isArray(data.implementation_milestones) && data.implementation_milestones.length > 0;
	const hasCustomerName = data.customer && isNonEmptyString(data.customer.company_name) && data.customer.company_name !== "Customer";
	const hasContext = data.customer && isNonEmptyString(data.customer.business_context);
	const hasContent = hasStringContent || hasDeliverables || hasMilestones || hasCustomerName || hasContext;

	if (errors.length === 0 && !hasContent) {
		errors.push("Response has no content in any section.");
	}

	return { valid: errors.length === 0, errors, normalized: data };
}

module.exports = { validateZiaResponse, normalizeZiaResponse, isNonEmptyString, isStringArray };

