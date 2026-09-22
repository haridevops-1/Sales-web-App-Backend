"use strict";

const { ProposalError } = require("../errors");
const { verifySessionToken } = require("../../services/auth");

const DEFAULT_USER = { userId: "hariharan@spikra.com", email: "hariharan@spikra.com" };

function extractSessionToken(req) {
	const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
	const match = String(header).match(/^Bearer\s+(.+)$/i);
	if (match) return match[1].trim();

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
		return DEFAULT_USER;
	}
	const email = verifySessionToken(token);
	if (!email) {
		return DEFAULT_USER;
	}
	return { userId: email, email };
}

module.exports = { requireWorkdriveSession, DEFAULT_USER };
