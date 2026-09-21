"use strict";

// Structured, single-line logs for Workspace 2 functions. Never pass secrets, tokens,
// or raw document/file content into these - only identifiers, status, and timing.
function logEvent(fn, { requestId, operation, proposalId, packageId, status, durationMs, errorCode } = {}) {
	const entry = {
		fn,
		operation: operation || null,
		request_id: requestId || null,
		proposal_id: proposalId || null,
		package_id: packageId || null,
		status: status || null,
		duration_ms: typeof durationMs === "number" ? durationMs : null,
		error_code: errorCode || null
	};
	console.log(`[workspace2] ${JSON.stringify(entry)}`);
}

function newRequestId() {
	return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { logEvent, newRequestId };
