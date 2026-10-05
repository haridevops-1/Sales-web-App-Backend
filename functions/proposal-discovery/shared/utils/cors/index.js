"use strict";

const CATALYST_COVERED_ORIGIN = "https://spikra-ai-proposal-app.onslate.com";

function setAllowOriginHeader(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	res.setHeader("Access-Control-Allow-Origin", origin || "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
}

module.exports = { CATALYST_COVERED_ORIGIN, setAllowOriginHeader };
