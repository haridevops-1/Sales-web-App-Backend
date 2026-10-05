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

const THREE_DOC_KEYS = ["technical_document", "commercial_document", "tos_document"];

function isNonEmptyString(val) {
	return typeof val === "string" && val.trim().length > 0;
}

function isStringArray(val) {
	return Array.isArray(val) && val.every((item) => typeof item === "string");
}

function normalizeSection(sec, defaultHeading) {
	if (!sec) return { heading: defaultHeading, content: "", subsections: [] };
	if (typeof sec === "string") return { heading: defaultHeading, content: sec, subsections: [] };

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

function normalizeDocStructure(doc, defaultTitle) {
	if (!doc || typeof doc !== "object") {
		return { title: defaultTitle, sections: [] };
	}
	const title = String(doc.title || doc.name || defaultTitle).trim();
	const rawSections = Array.isArray(doc.sections) ? doc.sections : [];
	const sections = rawSections.map((sec, idx) => normalizeSection(sec, `Section ${idx + 1}`));
	return { title, sections };
}

function normalizeZiaResponse(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const data = { ...raw };

	if (!data.customer || typeof data.customer !== "object") {
		data.customer = {
			company_name: String(data.customer_name || data.company_name || data.client_name || "Customer Organization").trim(),
			industry: String(data.industry || "").trim(),
			business_context: String(data.business_context || data.overview || "").trim()
		};
	} else {
		data.customer = {
			company_name: String(data.customer.company_name || data.customer.name || data.customer.company || "Customer Organization").trim(),
			industry: String(data.customer.industry || "").trim(),
			business_context: String(data.customer.business_context || data.customer.context || "").trim()
		};
	}

	const companyName = data.customer.company_name || "Customer Organization";

	// Normalize the 3 structured documents
	data.technical_document = normalizeDocStructure(data.technical_document, `${companyName} — Technical Specification`);
	data.commercial_document = normalizeDocStructure(data.commercial_document, `${companyName} — Commercial Proposal`);
	data.tos_document = normalizeDocStructure(data.tos_document, `${companyName} — Terms of Service & SLA`);

	// Also normalize legacy fields for full backward compatibility
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

// Structural check only (shape, types) - verifies that at least one of the 3 structured
// documents has valid sections, or that legacy fields provide substantive content.
function validateZiaResponse(raw) {
	const errors = [];
	const data = normalizeZiaResponse(raw);

	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { valid: false, errors: ["Response is not a JSON object."], normalized: null };
	}

	if (!data.customer || typeof data.customer !== "object") {
		errors.push("Missing or invalid 'customer' object.");
	} else {
		if (typeof data.customer.industry !== "string") errors.push("customer.industry must be a string.");
		if (typeof data.customer.business_context !== "string") errors.push("customer.business_context must be a string.");
	}

	// Verify that the 3 document objects exist and have valid structure
	for (const docKey of THREE_DOC_KEYS) {
		const doc = data[docKey];
		if (!doc || typeof doc !== "object") {
			errors.push(`Missing or invalid '${docKey}' object.`);
		} else {
			if (!Array.isArray(doc.sections)) {
				errors.push(`'${docKey}.sections' must be an array.`);
			}
		}
	}

	// Content gate: check that at least one document has substantive sections
	const hasTechnicalSections = Array.isArray(data.technical_document?.sections) && data.technical_document.sections.length > 0;
	const hasCommercialSections = Array.isArray(data.commercial_document?.sections) && data.commercial_document.sections.length > 0;
	const hasTosSections = Array.isArray(data.tos_document?.sections) && data.tos_document.sections.length > 0;
	const hasDocumentContent = hasTechnicalSections || hasCommercialSections || hasTosSections;

	// Legacy content fallback check
	const hasLegacyArrayContent = ZIA_RESPONSE_ARRAY_FIELDS.some((field) => Array.isArray(data[field]) && data[field].length > 0);
	const hasDeliverables = Array.isArray(data.deliverables) && data.deliverables.length > 0;
	const hasCustomerContext = isNonEmptyString(data.customer?.business_context);
	const hasSubstantiveContent = hasDocumentContent || hasLegacyArrayContent || hasDeliverables || hasCustomerContext;

	if (errors.length === 0 && !hasSubstantiveContent) {
		errors.push("Response has no substantive content in technical, commercial, or TOS documents.");
	}

	return { valid: errors.length === 0, errors, normalized: data };
}

module.exports = { validateZiaResponse, normalizeZiaResponse, isNonEmptyString, isStringArray };

