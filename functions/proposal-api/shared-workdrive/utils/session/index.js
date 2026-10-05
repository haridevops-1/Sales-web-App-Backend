"use strict";

const { URL } = require("url");
const { verifySessionTokenWithStatus } = require("../../services/auth");
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

	if (req && req.query && req.query.session_token) {
		return String(req.query.session_token).trim();
	}

	return null;
}

function requireSession(req) {
	const token = extractSessionToken(req);
	if (!token) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "A WorkDrive session token is required.", 401);
	}
	const status = verifySessionTokenWithStatus(token);
	if (!status || !status.valid) {
		throw new WorkdriveError(
			(status && status.code) || "WORKDRIVE_AUTH_FAILED",
			(status && status.message) || "WorkDrive session is invalid or expired.",
			401
		);
	}
	const sessionData = status.session;
	if (!sessionData || !sessionData.email) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "This WorkDrive session is invalid or has expired. Please reconnect.", 401);
	}
	return {
		userId: sessionData.email,
		email: sessionData.email,
		...sessionData
	};
}

async function decodeSession(req) {
	try {
		return requireSession(req);
	} catch {
		return null;
	}
}

module.exports = { requireSession, decodeSession, extractSessionToken };
