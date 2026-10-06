"use strict";

// Real OAuth 2.0 against Zoho's own WorkDrive endpoints - NOT the Catalyst Connections
// feature (Connections return one shared credential set for every caller, which can't
// represent one salesperson's own WorkDrive access). There is no separate app login:
// clicking "Open WorkDrive" goes straight to Zoho's own login/consent page. Once that
// succeeds, Zoho is the identity check - we issue our own signed session token (tied to
// the salesperson's email, never a password) so later requests know who's asking, the
// same way any "Login with Google" style app works. Their Zoho email + OAuth token are
// stored in WORKDRIVE_CONNECTIONS; their password is never seen by this backend at any
// point - it's entered only on Zoho's own page and never sent to us. Shared by both
// Workspace 1 and Workspace 2 - a salesperson's WorkDrive connection is the same
// regardless of which pipeline they're using it from.
//
// NOT YET VERIFIED LIVE: Zoho's OAuth/user-info endpoint shapes below are the standard,
// publicly documented ones - confirm against a real self-client + real consent flow
// once WORKDRIVE_OAUTH_CLIENT_ID/SECRET exist.

const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const { WorkdriveError } = require("../../utils/errors");

const DEFAULT_ACCOUNTS_DOMAIN = "https://accounts.zoho.com";
// WorkDrive.users.READ ("Get All Teams of User") and WorkDrive.teamfolders.READ ("Get
// Team Folders in a Team") are required to discover Team Folders at all - without them
// every /teams/*/teamfolders call is silently denied and the root listing falls back to
// showing only My Folders (Private Space), which is exactly what was happening.
const WORKDRIVE_SCOPES = "WorkDrive.files.READ,WorkDrive.users.READ,WorkDrive.teamfolders.READ,ZohoFiles.files.READ,AaaServer.profile.READ";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getAccountsDomain() {
	return String(process.env.ZOHO_ACCOUNTS_DOMAIN || DEFAULT_ACCOUNTS_DOMAIN).trim().replace(/\/+$/, "");
}

function getOAuthConfig() {
	const clientId = String(process.env.WORKDRIVE_OAUTH_CLIENT_ID || "").trim();
	const clientSecret = String(process.env.WORKDRIVE_OAUTH_CLIENT_SECRET || "").trim();
	const redirectUri = String(process.env.WORKDRIVE_OAUTH_REDIRECT_URI || "").trim();
	if (!clientId || !clientSecret || !redirectUri) {
		throw new WorkdriveError(
			"WORKDRIVE_AUTH_FAILED",
			"WorkDrive OAuth is not configured (WORKDRIVE_OAUTH_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI)."
		);
	}
	return { clientId, clientSecret, redirectUri };
}

// No user identity is known yet at this point - state is a plain CSRF nonce (proves
// the callback belongs to a browser session that actually started this flow), not a
// carrier for "which salesperson." Identity comes from Zoho's own login, after the fact.
function buildAuthorizeUrl(customAccountsDomain, clientOrigin) {
	const domain = (customAccountsDomain || getAccountsDomain()).replace(/\/+$/, "");
	const { clientId, redirectUri } = getOAuthConfig();
	const nonce = crypto.randomBytes(16).toString("hex");
	const safeOrigin = clientOrigin ? encodeURIComponent(String(clientOrigin).trim()) : "";
	const statePayload = safeOrigin ? `nonce.${nonce}.${safeOrigin}` : `nonce.${nonce}`;
	const state = signPayload(statePayload, 2 * 60 * 60 * 1000); // 2 hours TTL
	const url = new URL(`${domain}/oauth/v2/auth`);
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
	const payload = verifySignedPayload(state);
	if (!payload) return null;
	const parts = payload.split(".");
	if (parts.length >= 3 && parts[0] === "nonce") {
		try {
			return { nonce: parts[1], origin: decodeURIComponent(parts[2]) };
		} catch {
			return { nonce: parts[1], origin: null };
		}
	}
	return { nonce: payload, origin: null };
}

async function exchangeCodeForToken(code, accountsDomain) {
	const domain = (accountsDomain || getAccountsDomain()).replace(/\/+$/, "");
	const { clientId, clientSecret, redirectUri } = getOAuthConfig();
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUri,
		code
	});
	return postForm(`${domain}/oauth/v2/token`, body);
}

async function refreshAccessToken(refreshToken, accountsDomain) {
	const domain = (accountsDomain || getAccountsDomain()).replace(/\/+$/, "");
	const { clientId, clientSecret } = getOAuthConfig();
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken
	});
	return postForm(`${domain}/oauth/v2/token`, body);
}

// Looks up whose email this connection belongs to using Zoho Accounts, with fallback to WorkDrive /users/me.
async function fetchZohoUserInfo(accessToken, accountsDomain, userApiDomain) {
	const domain = (accountsDomain || getAccountsDomain()).replace(/\/+$/, "");
	try {
		const info = await fetchAccountsUserInfo(accessToken, domain);
		if (info && info.email) return info;
	} catch (err) {
		console.warn("[WorkDrive Auth] Accounts user/info failed, trying WorkDrive /users/me fallback:", err.message);
	}
	return fetchWorkdriveCurrentUser(accessToken, domain, userApiDomain);
}

function fetchAccountsUserInfo(accessToken, domain) {
	return new Promise((resolve, reject) => {
		const url = new URL(`${domain}/oauth/user/info`);
		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: url.pathname + url.search,
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
							return reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Could not determine the Zoho account's email from Accounts API."));
						}
						resolve({ email, displayName: parsed.Display_Name || parsed.display_name || null });
					} catch {
						reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Zoho user-info returned a non-JSON response."));
					}
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", "Zoho user-info request timed out.")); });
		req.on("error", (err) => reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Failed to reach Zoho user-info: ${err.message}`)));
		req.end();
	});
}

function fetchWorkdriveCurrentUser(accessToken, accountsDomain, userApiDomain) {
	return new Promise((resolve, reject) => {
		let apiDomain = userApiDomain || "";
		if (!apiDomain) {
			const accountsLower = (accountsDomain || "").toLowerCase();
			if (accountsLower.includes(".zoho.in")) {
				apiDomain = "https://www.zohoapis.in/workdrive/api/v1";
			} else if (accountsLower.includes(".zoho.eu")) {
				apiDomain = "https://www.zohoapis.eu/workdrive/api/v1";
			} else if (accountsLower.includes(".zoho.com.au")) {
				apiDomain = "https://www.zohoapis.com.au/workdrive/api/v1";
			} else if (process.env.WORKDRIVE_API_DOMAIN && !accountsLower.includes(".zoho.")) {
				apiDomain = String(process.env.WORKDRIVE_API_DOMAIN).trim().replace(/\/+$/, "");
			} else {
				apiDomain = "https://www.zohoapis.com/workdrive/api/v1";
			}
		}
		const url = new URL(`${apiDomain}/users/me`);
		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: url.pathname + url.search,
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
						const attrs = (parsed.data && parsed.data.attributes) || {};
						const email = attrs.email_id || attrs.email;
						if (!email) {
							return reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Could not determine Zoho user email from WorkDrive API."));
						}
						const displayName = attrs.display_name || `${attrs.first_name || ""} ${attrs.last_name || ""}`.trim() || null;
						resolve({ email, displayName });
					} catch {
						reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive user-info returned a non-JSON response."));
					}
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", "WorkDrive user-info request timed out.")); });
		req.on("error", (err) => reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Failed to reach WorkDrive user-info: ${err.message}`)));
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
						return reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Zoho OAuth returned a non-JSON response."));
					}
					if (parsed.error) {
						return reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Zoho OAuth error: ${parsed.error}`));
					}
					resolve(parsed);
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", "Zoho OAuth request timed out.")); });
		req.on("error", (err) => reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Failed to reach Zoho OAuth: ${err.message}`)));
		req.write(bodyString);
		req.end();
	});
}

// VERIFY: Zoho's documented token-revoke endpoint - called on disconnect so the grant
// actually stops working at Zoho's end, not just in our own WORKDRIVE_CONNECTIONS row.
// Callers treat a failure here as best-effort (the local row is still marked disconnected
// either way) since the exact response shape hasn't been confirmed against a real revoke
// call yet.
function revokeToken(token) {
	const body = new URLSearchParams({ token });
	return postForm(`${getAccountsDomain()}/oauth/v2/token/revoke`, body).catch((err) => {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Failed to revoke the WorkDrive token: ${err.message}`);
	});
}

function getTokenEncryptionKey() {
	const raw = String(process.env.WORKDRIVE_TOKEN_ENCRYPTION_KEY || process.env.WORKDRIVE_SESSION_SECRET || "7064d086dc4de1854048422b8c4b1807bbaeeba8a4ac41d8e93900ecdc56b019").trim();
	return crypto.createHash("sha256").update(raw).digest();
}

function getSessionSecret() {
	const raw = String(process.env.WORKDRIVE_SESSION_SECRET || "6920e440762c83c3219966abb8da6714f1801961831e989b861e9c99e5b52c7a").trim();
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

function maskToken(token) {
	if (!token || typeof token !== "string") return "***";
	const clean = token.trim();
	if (clean.length <= 12) return "***";
	return `${clean.slice(0, 8)}...***`;
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
	if (raw.length < 28) {
		throw new Error("Invalid encrypted token length");
	}
	const iv = raw.subarray(0, 12);
	const authTag = raw.subarray(12, 28);
	const encrypted = raw.subarray(28);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// Session tokens are what the frontend holds after a successful WorkDrive connection.
// Supports stateless self-contained encrypted tokens (sess_v2.<encrypted>) so every
// function and container has immediate access to decrypted OAuth tokens without DB dependency.
function issueSessionToken(dataOrEmail) {
	if (dataOrEmail && typeof dataOrEmail === "object") {
		const sessionObj = {
			email: String(dataOrEmail.email || "").toLowerCase().trim(),
			displayName: dataOrEmail.displayName || null,
			accessToken: dataOrEmail.accessToken || null,
			refreshToken: dataOrEmail.refreshToken || null,
			expiresAt: dataOrEmail.expiresAt || new Date(Date.now() + Number(dataOrEmail.expiresIn || 3600) * 1000).toISOString(),
			scope: dataOrEmail.scope || null,
			apiDomain: dataOrEmail.apiDomain || null
		};
		const encrypted = encryptToken(JSON.stringify(sessionObj));
		return signPayload(`sess_v2.${encrypted}`, SESSION_TTL_MS);
	}
	return signPayload(`session.${dataOrEmail}`, SESSION_TTL_MS);
}

function verifySessionTokenWithStatus(token) {
	if (!token || typeof token !== "string") {
		return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Missing or invalid session token." };
	}

	let rawToken = token.trim();
	if (rawToken.startsWith("Bearer ")) {
		rawToken = rawToken.slice(7).trim();
	}

	try {
		let payload = null;

		// 1. If wrapped in HMAC signature (base64url)
		try {
			const decoded = Buffer.from(rawToken, "base64url").toString("utf8");
			const parts = decoded.split(".");
			if (parts.length >= 3) {
				const hmac = parts.pop();
				const expiresAt = parts.pop();
				const rawPayload = parts.join(".");
				const expected = crypto.createHmac("sha256", getSessionSecret()).update(`${rawPayload}.${expiresAt}`).digest("hex");
				if (hmac !== expected) {
					return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Session token signature verification failed." };
				}
				if (Date.now() > Number(expiresAt)) {
					return { valid: false, code: "WORKDRIVE_TOKEN_EXPIRED", message: "Session token has expired. Please reconnect." };
				}
				payload = rawPayload;
			}
		} catch {}

		// 2. Direct format support (e.g. sess_v2.<encrypted> or session_v2.<encrypted>)
		if (!payload) {
			if (rawToken.startsWith("sess_v2.") || rawToken.startsWith("session_v2.")) {
				payload = rawToken;
			} else {
				payload = `sess_v2.${rawToken}`;
			}
		}

		if (payload.startsWith("sess_v2.") || payload.startsWith("session_v2.")) {
			const prefix = payload.startsWith("sess_v2.") ? "sess_v2." : "session_v2.";
			const encrypted = payload.slice(prefix.length);
			let decrypted;
			try {
				decrypted = decryptToken(encrypted);
			} catch (decErr) {
				return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Session token authentication tag verification failed." };
			}
			if (!decrypted) {
				return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Session token is malformed." };
			}
			let sessionObj;
			try {
				sessionObj = JSON.parse(decrypted);
			} catch {
				return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Session token contains invalid payload." };
			}
			return { valid: true, session: sessionObj };
		}

		if (payload.startsWith("session.")) {
			const email = payload.slice("session.".length);
			return { valid: true, session: { email } };
		}

		return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: "Unsupported session token format." };
	} catch (err) {
		return { valid: false, code: "WORKDRIVE_AUTH_FAILED", message: `Session authentication error: ${err.message}` };
	}
}

function verifySessionToken(token) {
	const status = verifySessionTokenWithStatus(token);
	return status.valid ? status.session : null;
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
	verifySessionTokenWithStatus,
	encryptToken,
	decryptToken,
	maskToken,
	WORKDRIVE_SCOPES
};
