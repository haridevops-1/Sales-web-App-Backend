"use strict";

// The one place every Workspace 2 function resolves "who is calling." There is no
// separate app login - Zoho's own WorkDrive OAuth IS the identity check. After a
// successful connection, the frontend holds a signed session token (issued by
// services/auth's issueSessionToken, tied to the salesperson's email, never a
// password) and sends it back as "Authorization: Bearer <token>" on every request.
// Never trust a user_id/email from the request body - always resolve it from this
// verified session token.

const { ProposalError } = require("../errors");
const { verifySessionToken } = require("../../services/auth");

function extractSessionToken(req) {
	const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
	const match = String(header).match(/^Bearer\s+(.+)$/i);
	if (match) return match[1].trim();

	// Fallback for browser navigations (e.g. WorkDrive's own OAuth callback redirect)
	// where an Authorization header can't be set - a query param is acceptable there
	// since the token is only ever read, never a secret an attacker gains by seeing it
	// in a URL they don't already control (it's already only usable by whoever holds it).
	try {
		const urlObj = new URL(req.url, `http://${(req.headers && req.headers.host) || "localhost"}`);
		const qsToken = urlObj.searchParams.get("session_token");
		if (qsToken) return qsToken;
	} catch {}

	return null;
}

async function requireWorkdriveSession(req) {
	const token = extractSessionToken(req);
	if (!token) {
		throw new ProposalError("UNAUTHENTICATED", "Connect WorkDrive first.", 401);
	}
	const email = verifySessionToken(token);
	if (!email) {
		throw new ProposalError("SESSION_EXPIRED", "Your WorkDrive connection session has expired. Please reconnect.", 401);
	}
	return { userId: email, email };
}

module.exports = { requireWorkdriveSession };
