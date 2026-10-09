"use strict";

// Strict allowlist: ONLY these origins, confirmed live via the Catalyst MCP API as the
// project's actual Authorised Domains (CORS enabled), are permitted. Any other origin gets
// no Access-Control-Allow-Origin header at all, so the browser blocks the request - this is
// intentional, not a bug. Catalyst's own platform/gateway already injects this header for
// these exact origins; if this function ALSO set it, the response would carry two separate
// Access-Control-Allow-Origin header lines, which browsers treat as invalid and reject - so
// this function deliberately stays silent for them and relies on the platform's header.
// To allow a new domain: add it in Catalyst Console/Authorised Domains (or via the MCP
// Create_CORS_Domain call) AND add it here, in the same list used across all 8 functions.
const PLATFORM_COVERED_ORIGINS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"https://spikra-ai-proposal.onslate.com",
	"https://spikra-w2-proposal-jmdbymcs.onslate.com"
];

function setAllowOriginHeader(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (!PLATFORM_COVERED_ORIGINS.includes(origin)) {
		// Not an authorised origin - no header set, so the browser's CORS check fails closed.
		return;
	}
	// Covered origin - the platform already sets Access-Control-Allow-Origin, don't duplicate it.

	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Workdrive-Token, X-Session-Token, session_token, x-catalyst-session-token");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = { setAllowOriginHeader };
