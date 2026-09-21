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

// Structural check only (shape, types) - not "is this a good proposal." A structurally
// valid response with thin content is still valid; an empty/malformed one is not.
function validateZiaResponse(data) {
	const errors = [];

	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { valid: false, errors: ["Response is not a JSON object."] };
	}

	if (!data.customer || typeof data.customer !== "object") {
		errors.push("Missing or invalid 'customer' object.");
	} else {
		if (!isNonEmptyString(data.customer.company_name)) errors.push("customer.company_name is required.");
		if (typeof data.customer.industry !== "string") errors.push("customer.industry must be a string.");
		if (typeof data.customer.business_context !== "string") errors.push("customer.business_context must be a string.");
	}

	for (const field of ZIA_RESPONSE_ARRAY_FIELDS) {
		if (!isStringArray(data[field])) {
			errors.push(`'${field}' must be an array of strings.`);
		}
	}

	// At least a title and one substantive section - mirrors Workspace 1's minimum-content
	// gate so a near-empty response is rejected rather than stored as a "successful" proposal.
	const hasContent = ZIA_RESPONSE_ARRAY_FIELDS.some((field) => Array.isArray(data[field]) && data[field].length > 0);
	if (errors.length === 0 && !hasContent) {
		errors.push("Response has no content in any section.");
	}

	return { valid: errors.length === 0, errors };
}

module.exports = { validateZiaResponse, isNonEmptyString, isStringArray };
