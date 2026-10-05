"use strict";

// Resolves "which salesperson is making this request" from the signed session token
// issued by workdrive-auth after a successful Zoho WorkDrive login. Unlike the previous
// Workspace 2 version of this file, a missing or invalid token is a real failure here -
// requireSession() throws, it never silently returns a default identity. Every caller
// that needs a real, authenticated user must let that exception propagate into a 401,
// not swallow it and proceed as someone else.
const { URL } = require("url");
const { verifySessionToken } = require("../../services/auth");
const { WorkdriveError } = require("../errors");

function extractSessionToken(req) {
	const headers = (req && req.headers) || {};

	// Custom non-colliding headers that Catalyst API Gateway won't intercept
	const customHeader = headers["x-workdrive-token"] || headers["x-session-token"] || headers["x-catalyst-session-token"] || "";
	if (customHeader) return String(customHeader).trim();

	const authHeader = headers.authorization || headers.Authorization || "";
	const match = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
	if (match) return match[1].trim();

	try {
		const url = new URL(req.url, `http://${headers.host || "localhost"}`);
		const qsToken = url.searchParams.get("session_token");
		if (qsToken) return qsToken.trim();
	} catch {}

	return null;
}

function requireSession(req) {
	const token = extractSessionToken(req);
	if (!token) {
		throw new WorkdriveError("UNAUTHENTICATED", "A WorkDrive session token is required.", 401);
	}
	const email = verifySessionToken(token);
	if (!email) {
		throw new WorkdriveError("SESSION_EXPIRED", "This WorkDrive session is invalid or has expired. Please reconnect.", 401);
	}
	return { userId: email, email };
}

module.exports = { requireSession, extractSessionToken };
