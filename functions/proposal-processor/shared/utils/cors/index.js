"use strict";

// Catalyst's platform-level CORS injection for "covered" origins is not reliable across
// every execution domain a request can arrive on (e.g. the raw *.development.catalystserverless.com
// execution URL vs. a custom/production domain) - confirmed via direct curl that the header
// is sometimes absent even for the hub domain depending on which domain the request hits.
// So this function always sets its own Access-Control-Allow-Origin header for every known
// origin instead of trusting the platform to inject it.
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
	if (ALLOWED_ORIGIN_PATTERNS.includes(origin) || origin.endsWith(".onslate.com") || origin.endsWith(".zohocatalyst.com") || origin.endsWith(".zohocatalyst.in")) {
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
