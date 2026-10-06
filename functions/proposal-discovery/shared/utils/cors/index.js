"use strict";

const CATALYST_COVERED_ORIGINS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"https://spikra-ai-proposal.onslate.com"
];

const ALLOWED_ORIGIN_PATTERNS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"https://spikra-ai-proposal.onslate.com",
	"http://localhost:5173",
	"http://localhost:3000",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:3000"
];

function isCatalystCoveredOrigin(origin) {
	if (!origin) return false;
	const clean = String(origin).trim().toLowerCase();
	return CATALYST_COVERED_ORIGINS.some((cov) => clean === cov.toLowerCase());
}

function setAllowOriginHeader(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (!isCatalystCoveredOrigin(origin)) {
		if (ALLOWED_ORIGIN_PATTERNS.includes(origin) || origin.endsWith(".onslate.com") || origin.endsWith(".zohocatalyst.com") || origin.endsWith(".zohocatalyst.in")) {
			res.setHeader("Access-Control-Allow-Origin", origin);
		} else if (!origin) {
			res.setHeader("Access-Control-Allow-Origin", "*");
		} else {
			res.setHeader("Access-Control-Allow-Origin", origin);
		}
	}

	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Workdrive-Token, X-Session-Token, session_token, x-catalyst-session-token");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = { CATALYST_COVERED_ORIGINS, isCatalystCoveredOrigin, setAllowOriginHeader };
