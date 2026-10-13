"use strict";

const { authenticate } = require("../../services/users");
const { WorkdriveError } = require("../errors");

// The token travels in X-Session-Token only. The Catalyst gateway intercepts the standard
// Authorization header and rejects unknown tokens before the function runs, and a token in
// the URL would leak into logs, browser history and Referer headers.
function extractSessionToken(req) {
	const value = req && req.headers && req.headers["x-session-token"];
	return value ? String(value).trim() : null;
}

// Resolves the signed-in user or throws a 401. There is no default identity.
async function requireSession(app, req) {
	const token = extractSessionToken(req);
	if (!token) throw new WorkdriveError("UNAUTHENTICATED", "Sign in to continue.", 401);
	return authenticate(app, token);
}

module.exports = { requireSession, extractSessionToken };
