"use strict";

const { validateZiaResponse } = require("../../utils/validation");
const { ProposalError } = require("../../utils/errors");

const VALID_STATUSES = ["Draft", "In Review", "Approved"];

// Draft can move to In Review; In Review can move to Approved or back to Draft; Approved
// is terminal for this milestone. Matches Section 15 - initial status is always Draft.
const ALLOWED_TRANSITIONS = {
	Draft: ["In Review"],
	"In Review": ["Approved", "Draft"],
	Approved: []
};

function isValidStatusTransition(fromStatus, toStatus) {
	if (!VALID_STATUSES.includes(toStatus)) return false;
	if (fromStatus === toStatus) return true;
	const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
	return allowed.includes(toStatus);
}

// Validates the raw Zia response and, only if structurally valid, builds the PROPOSALS
// row payload. Throws INVALID_ZIA_RESPONSE rather than storing a malformed/empty result -
// same anti-hallucination discipline as Workspace 1's SchemaValidationError.
function buildProposalRecord(ziaResponse, { packageId, userId, dealValue = 0 }) {
	const { valid, errors, normalized } = validateZiaResponse(ziaResponse);
	if (!valid) {
		throw new ProposalError("INVALID_ZIA_RESPONSE", `Zia response failed validation: ${errors.join(" ")}`);
	}
	const responseData = normalized || ziaResponse;

	const companyName = String(responseData.customer.company_name || "").trim();
	const industry = String(responseData.customer.industry || "").trim();

	return {
		package_id: packageId,
		user_id: userId,
		customer_name: companyName,
		industry,
		proposal_title: companyName ? `${companyName} — Solution Proposal` : "Solution Proposal",
		status: "Draft",
		deal_value: Number(dealValue) || 0,
		proposal_content: JSON.stringify(responseData)
	};
}

// Single source of truth for where a proposal's rendered document lives in the
// spikra-w2-proposal-documents Stratus bucket - defined once and shared by the writer
// (proposal-processor) and the reader (proposal-api's public view route) so they can
// never drift apart. Scoped by user then package (the salesperson's WorkDrive-connected
// email, then the discovery session/package it came from) so the bucket's own folder
// structure is self-explanatory without needing to open the Data Store to know whose
// document is whose.
function buildProposalDocumentKey(userId, packageId, proposalId) {
	return `proposals/${encodeURIComponent(userId)}/${encodeURIComponent(packageId)}/${encodeURIComponent(proposalId)}/index.html`;
}

module.exports = { VALID_STATUSES, isValidStatusTransition, buildProposalRecord, buildProposalDocumentKey };
