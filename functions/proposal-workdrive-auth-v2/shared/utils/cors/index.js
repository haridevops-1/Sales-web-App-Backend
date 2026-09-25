"use strict";

// Catalyst's own CORS allowlist already injects Access-Control-Allow-Origin for
// spikra-ai-proposal-app.onslate.com (confirmed live on Workspace 1's Function 3 -
// setting our own value on top of that produced "header contains multiple values" and
// the browser rejected the response outright). Every other origin (local dev, etc.)
// isn't in that allowlist, so each function still needs to set its own header for them.
const CATALYST_COVERED_ORIGIN = "https://spikra-ai-proposal-app.onslate.com";

function setAllowOriginHeader(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (origin !== CATALYST_COVERED_ORIGIN) {
		res.setHeader("Access-Control-Allow-Origin", origin || "*");
	}
}

module.exports = { CATALYST_COVERED_ORIGIN, setAllowOriginHeader };
