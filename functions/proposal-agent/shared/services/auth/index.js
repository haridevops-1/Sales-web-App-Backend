"use strict";

// Real OAuth 2.0 against Zoho's own WorkDrive endpoints - NOT the Catalyst Connections
// feature (Connections return one shared credential set for every caller, confirmed in
// the plan). There is no separate app login: clicking "Open WorkDrive" goes straight to
// Zoho's own login/consent page. Once that succeeds, Zoho is the identity check - we
// issue our own signed session token (tied to the salesperson's email, never a
// password) so later requests know who's asking, the same way any "Login with Google"
// style app works. Their Zoho email + OAuth token are stored in WORKDRIVE_LOGIN; their
// password is never seen by this backend at any point - it's entered only on Zoho's own
// page and never sent to us.
//
// NOT YET VERIFIED LIVE: Zoho's OAuth/user-info endpoint shapes below are the standard,
// publicly documented ones - confirm against a real self-client + real consent flow
// once WORKDRIVE_OAUTH_CLIENT_ID/SECRET exist.

const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const { ProposalError } = require("../../utils/errors");

const DEFAULT_ACCOUNTS_DOMAIN = "https://accounts.zoho.com";
const WORKDRIVE_SCOPES = "WorkDrive.files.READ,ZohoFiles.files.READ";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getAccountsDomain() {
	return String(process.env.ZOHO_ACCOUNTS_DOMAIN || DEFAULT_ACCOUNTS_DOMAIN).trim().replace(/\/+$/, "");
}

function getOAuthConfig() {
	const clientId = String(process.env.WORKDRIVE_OAUTH_CLIENT_ID || "").trim();
	const clientSecret = String(process.env.WORKDRIVE_OAUTH_CLIENT_SECRET || "").trim();
	const redirectUri = String(process.env.WORKDRIVE_OAUTH_REDIRECT_URI || "").trim();
	if (!clientId || !clientSecret || !redirectUri) {
		throw new ProposalError(
			"WORKDRIVE_AUTH_FAILED",
			"WorkDrive OAuth is not configured (WORKDRIVE_OAUTH_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI)."
		);
	}
	return { clientId, clientSecret, redirectUri };
}

// No user identity is known yet at this point - state is a plain CSRF nonce (proves
// the callback belongs to a browser session that actually started this flow), not a
// carrier for "which salesperson." Identity comes from Zoho's own login, after the fact.
function buildAuthorizeUrl() {
	const { clientId, redirectUri } = getOAuthConfig();
	const state = signPayload(`nonce.${crypto.randomBytes(16).toString("hex")}`, 15 * 60 * 1000);
	const url = new URL(`${getAccountsDomain()}/oauth/v2/auth`);
	url.searchParams.set("scope", WORKDRIVE_SCOPES);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return url.toString();
}

function verifyState(state) {
	return verifySignedPayload(state) !== null;
}

async function exchangeCodeForToken(code) {
	const { clientId, clientSecret, redirectUri } = getOAuthConfig();
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUri,
		code
	});
	return postForm(`${getAccountsDomain()}/oauth/v2/token`, body);
}

async function refreshAccessToken(refreshToken) {
	const { clientId, clientSecret } = getOAuthConfig();
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken
	});
	return postForm(`${getAccountsDomain()}/oauth/v2/token`, body);
}

// Zoho's standard OAuth user-info endpoint - used once, right after the token exchange,
// purely to learn *whose* email this connection belongs to. Never touches a password.
function fetchZohoUserInfo(accessToken) {
	return new Promise((resolve, reject) => {
		const url = new URL(`${getAccountsDomain()}/oauth/user/info`);
		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: url.pathname,
				method: "GET",
				headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
				timeout: 30000
			},
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => { raw += chunk; });
				res.on("end", () => {
					try {
						const parsed = JSON.parse(raw);
						const email = parsed.Email || parsed.email;
						if (!email) {
							return reject(new ProposalError("WORKDRIVE_AUTH_FAILED", "Could not determine the Zoho account's email."));
						}
						resolve({ email, displayName: parsed.Display_Name || parsed.display_name || null });
					} catch {
						reject(new ProposalError("WORKDRIVE_AUTH_FAILED", "Zoho user-info returned a non-JSON response."));
					}
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new ProposalError("TIMEOUT", "Zoho user-info request timed out.")); });
		req.on("error", (err) => reject(new ProposalError("WORKDRIVE_AUTH_FAILED", `Failed to reach Zoho user-info: ${err.message}`)));
		req.end();
	});
}

function postForm(urlString, body) {
	return new Promise((resolve, reject) => {
		const url = new URL(urlString);
		const bodyString = body.toString();
		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Content-Length": Buffer.byteLength(bodyString)
				},
				timeout: 30000
			},
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => { raw += chunk; });
				res.on("end", () => {
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch {
						return reject(new ProposalError("WORKDRIVE_AUTH_FAILED", "Zoho OAuth returned a non-JSON response."));
					}
					if (parsed.error) {
						return reject(new ProposalError("WORKDRIVE_AUTH_FAILED", `Zoho OAuth error: ${parsed.error}`));
					}
					resolve(parsed);
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new ProposalError("TIMEOUT", "Zoho OAuth request timed out.")); });
		req.on("error", (err) => reject(new ProposalError("WORKDRIVE_AUTH_FAILED", `Failed to reach Zoho OAuth: ${err.message}`)));
		req.write(bodyString);
		req.end();
	});
}

// VERIFY: Zoho's documented token-revoke endpoint - called on disconnect so the grant
// actually stops working at Zoho's end, not just in our own WORKDRIVE_LOGIN row. Callers
// treat a failure here as best-effort (the local row is still marked disconnected either
// way) since the exact response shape hasn't been confirmed against a real revoke call yet.
function revokeToken(token) {
	const body = new URLSearchParams({ token });
	return postForm(`${getAccountsDomain()}/oauth/v2/token/revoke`, body).catch((err) => {
		throw new ProposalError("WORKDRIVE_AUTH_FAILED", `Failed to revoke the WorkDrive token: ${err.message}`);
	});
}

function getTokenEncryptionKey() {
	const raw = String(process.env.WORKDRIVE_TOKEN_ENCRYPTION_KEY || "").trim();
	if (!raw) {
		throw new ProposalError("WORKDRIVE_AUTH_FAILED", "WORKDRIVE_TOKEN_ENCRYPTION_KEY is not configured.");
	}
	return crypto.createHash("sha256").update(raw).digest();
}

// Deliberately a separate secret from the token encryption key - this one signs session
// tokens the frontend holds, that key encrypts OAuth tokens at rest; a leak of one
// should not automatically compromise the other.
function getSessionSecret() {
	const raw = String(process.env.WORKDRIVE_SESSION_SECRET || "").trim();
	if (!raw) {
		throw new ProposalError("UNAUTHENTICATED", "WORKDRIVE_SESSION_SECRET is not configured.", 401);
	}
	return raw;
}

function signPayload(payload, ttlMs) {
	const expiresAt = Date.now() + ttlMs;
	const raw = `${payload}.${expiresAt}`;
	const hmac = crypto.createHmac("sha256", getSessionSecret()).update(raw).digest("hex");
	return Buffer.from(`${raw}.${hmac}`).toString("base64url");
}

function verifySignedPayload(token) {
	try {
		const decoded = Buffer.from(String(token), "base64url").toString("utf8");
		const parts = decoded.split(".");
		const hmac = parts.pop();
		const expiresAt = parts.pop();
		const payload = parts.join(".");
		const expected = crypto.createHmac("sha256", getSessionSecret()).update(`${payload}.${expiresAt}`).digest("hex");
		if (hmac !== expected) return null;
		if (Date.now() > Number(expiresAt)) return null;
		return payload;
	} catch {
		return null;
	}
}

// Session tokens are what the frontend holds after a successful WorkDrive connection -
// they identify "which salesperson" on every later request. Not a password, not an
// OAuth token itself; just a signed pointer to their WORKDRIVE_LOGIN row by email.
function issueSessionToken(email) {
	return signPayload(`session.${email}`, SESSION_TTL_MS);
}

function verifySessionToken(token) {
	const payload = verifySignedPayload(token);
	if (!payload || !payload.startsWith("session.")) return null;
	return payload.slice("session.".length);
}

function encryptToken(plainText) {
	if (!plainText) return null;
	const key = getTokenEncryptionKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptToken(encoded) {
	if (!encoded) return null;
	const key = getTokenEncryptionKey();
	const raw = Buffer.from(encoded, "base64");
	const iv = raw.subarray(0, 12);
	const authTag = raw.subarray(12, 28);
	const encrypted = raw.subarray(28);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

module.exports = {
	buildAuthorizeUrl,
	verifyState,
	exchangeCodeForToken,
	refreshAccessToken,
	revokeToken,
	fetchZohoUserInfo,
	issueSessionToken,
	verifySessionToken,
	encryptToken,
	decryptToken,
	WORKDRIVE_SCOPES
};
