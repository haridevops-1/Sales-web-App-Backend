"use strict";

// Ground truth confirmed directly via the Catalyst project's own Authorised Domains list
// (queried through the Catalyst MCP API, not guesswork): these 3 origins are registered
// there with CORS enabled, so Catalyst's platform/gateway injects Access-Control-Allow-Origin
// for them on its own. If this function ALSO sets the header for one of them, the response
// ends up with two separate Access-Control-Allow-Origin header lines, which browsers treat
// as an invalid CORS response and reject outright - so this function must skip setting its
// own header for exactly these origins. Keep this list in sync with the project's actual
// Authorised Domains; anything not in it still needs this function's own header.
const PLATFORM_COVERED_ORIGINS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"https://spikra-ai-proposal.onslate.com",
	"https://spikra-w2-proposal-jmdbymcs.onslate.com"
];

const ALLOWED_ORIGIN_PATTERNS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"https://spikra-ai-proposal.onslate.com",
	"http://localhost:5173",
	"http://localhost:3000",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:3000"
];

function setAllowOriginHeader(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (PLATFORM_COVERED_ORIGINS.includes(origin)) {
		// Deliberately not set - the platform already injects this header for these origins.
	} else if (ALLOWED_ORIGIN_PATTERNS.includes(origin) || origin.endsWith(".onslate.com") || origin.endsWith(".zohocatalyst.com") || origin.endsWith(".zohocatalyst.in")) {
		res.setHeader("Access-Control-Allow-Origin", origin);
	} else if (!origin) {
		res.setHeader("Access-Control-Allow-Origin", "*");
	} else {
		res.setHeader("Access-Control-Allow-Origin", origin);
	}

	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Workdrive-Token, X-Session-Token, session_token, x-catalyst-session-token");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = { setAllowOriginHeader };
