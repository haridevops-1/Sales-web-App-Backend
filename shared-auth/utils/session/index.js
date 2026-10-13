"use strict";

const { authenticate } = require("../../services/users");
const { WorkdriveError } = require("../errors");

// Tokens are accepted only from request headers - never from the URL, where they would
// leak into logs, browser history and Referer headers.
function extractSessionToken(req) {
	const headers = (req && req.headers) || {};
	const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || "").trim());
	if (match) return match[1].trim();
	const custom = headers["x-session-token"];
	return custom ? String(custom).trim() : null;
}

// Resolves the signed-in user or throws a 401. There is no default identity.
async function requireSession(app, req) {
	const token = extractSessionToken(req);
	if (!token) throw new WorkdriveError("UNAUTHENTICATED", "Sign in to continue.", 401);
	return authenticate(app, token);
}

module.exports = { requireSession, extractSessionToken };
