"use strict";

// Only origins listed in ALLOWED_ORIGINS (comma-separated, set per function in
// catalyst-config.json) get CORS headers; they must also be Authorised Domains in the
// Catalyst Console. Catalyst's gateway already sets Access-Control-Allow-Origin for those
// domains - setting it here too would produce a duplicate header that browsers reject - so
// this function adds only the remaining headers. Any other origin gets none, and the
// browser blocks the request.
function allowedOrigins() {
	return String(process.env.ALLOWED_ORIGINS || "")
		.split(",")
		.map((o) => o.trim().replace(/\/+$/, ""))
		.filter(Boolean);
}

function setAllowOriginHeader(req, res) {
	const origin = String((req.headers && req.headers.origin) || "").replace(/\/+$/, "");
	if (!origin || !allowedOrigins().includes(origin)) return;

	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Workdrive-Token, X-Session-Token");
	res.setHeader("Access-Control-Max-Age", "86400");
	res.setHeader("Vary", "Origin");
}

module.exports = { setAllowOriginHeader };
