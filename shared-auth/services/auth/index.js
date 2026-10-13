"use strict";

// Zoho OAuth 2.0 primitives shared by app sign-in (functions/app-auth) and the WorkDrive
// connection (functions/workdrive-auth), plus the AES-256-GCM helpers that protect stored
// WorkDrive tokens. Every secret comes from the environment and the module fails closed
// when one is missing - there are no defaults and no alternate endpoints.

const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const { WorkdriveError } = require("../../utils/errors");
const { requireEnv, allowedOriginOrNull, resolveRegion, defaultRegion } = require("../../utils/config");

const LOGIN_SCOPES = "AaaServer.profile.READ";
const WORKDRIVE_SCOPES = "WorkDrive.files.READ,WorkDrive.users.READ,WorkDrive.teamfolders.READ,ZohoFiles.files.READ,AaaServer.profile.READ";
const STATE_TTL_MS = 10 * 60 * 1000;

// Each flow has its own redirect URI (both registered on the same Zoho client).
const REDIRECT_ENV = { login: "ZOHO_LOGIN_REDIRECT_URI", workdrive: "ZOHO_WORKDRIVE_REDIRECT_URI" };

function getOAuthConfig(purpose) {
	return {
		clientId: requireEnv("ZOHO_OAUTH_CLIENT_ID"),
		clientSecret: requireEnv("ZOHO_OAUTH_CLIENT_SECRET"),
		redirectUri: requireEnv(REDIRECT_ENV[purpose])
	};
}

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function safeEqual(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- signed OAuth state -----------------------------------------------------------

function stateSecret() {
	return requireEnv("STATE_SIGNING_SECRET", 32);
}

function signState(payload) {
	const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })).toString("base64url");
	const sig = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
	return `${body}.${sig}`;
}

// Returns the payload for a valid, unexpired state of the expected purpose, else null.
function verifyState(state, purpose) {
	const parts = String(state || "").split(".");
	if (parts.length !== 2) return null;
	const expected = crypto.createHmac("sha256", stateSecret()).update(parts[0]).digest("base64url");
	if (!safeEqual(parts[1], expected)) return null;
	try {
		const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
		if (payload.p !== purpose || !(payload.exp > Date.now())) return null;
		const origin = allowedOriginOrNull(payload.o);
		const region = resolveRegion(payload.r);
		return origin ? { ...payload, origin, region } : null;
	} catch {
		return null;
	}
}

// purpose: "login" | "workdrive". extra is merged into the signed state (e.g. user binding).
function buildAuthorizeUrl({ purpose, regionInput, clientOrigin, extra }) {
	const origin = allowedOriginOrNull(clientOrigin);
	if (!origin) throw new WorkdriveError("FORBIDDEN", "Request origin is not allowed.", 403);
	const region = regionInput ? resolveRegion(regionInput) : defaultRegion();
	const { clientId, redirectUri } = getOAuthConfig(purpose);

	const state = signState({ p: purpose, n: crypto.randomBytes(16).toString("hex"), o: origin, r: region.key, ...(extra || {}) });
	const url = new URL(`${region.accounts}/oauth/v2/auth`);
	url.searchParams.set("scope", purpose === "login" ? LOGIN_SCOPES : WORKDRIVE_SCOPES);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("state", state);
	// Only the WorkDrive connection needs a long-lived grant. No "prompt": once a user has
	// approved, Zoho does not ask again until the grant is revoked (our Disconnect does that).
	if (purpose === "workdrive") url.searchParams.set("access_type", "offline");
	return url.toString();
}

// ---- Zoho HTTP --------------------------------------------------------------------

function httpsJson({ url, method, headers, body, label }) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const req = https.request(
			{ hostname: target.hostname, port: 443, path: target.pathname + target.search, method, headers, timeout: 30000 },
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => { raw += chunk; });
				res.on("end", () => {
					try {
						resolve(JSON.parse(raw));
					} catch {
						reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `${label} returned a non-JSON response.`, 502));
					}
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", `${label} request timed out.`, 504)); });
		req.on("error", () => reject(new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Failed to reach ${label}.`, 502)));
		if (body) req.write(body);
		req.end();
	});
}

async function postForm(region, path, params, label) {
	const body = new URLSearchParams(params).toString();
	const parsed = await httpsJson({
		url: `${region.accounts}${path}`,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
		body,
		label
	});
	if (parsed.error) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", `Zoho OAuth error: ${String(parsed.error).slice(0, 80)}`, 401);
	}
	return parsed;
}

function exchangeCodeForToken(code, region, purpose) {
	const { clientId, clientSecret, redirectUri } = getOAuthConfig(purpose);
	return postForm(region, "/oauth/v2/token", {
		grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code
	}, "Zoho OAuth");
}

function refreshAccessToken(refreshToken, region) {
	const clientId = requireEnv("ZOHO_OAUTH_CLIENT_ID");
	const clientSecret = requireEnv("ZOHO_OAUTH_CLIENT_SECRET");
	return postForm(region, "/oauth/v2/token", {
		grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken
	}, "Zoho OAuth");
}

function revokeToken(token, region) {
	return postForm(region, "/oauth/v2/token/revoke", { token }, "Zoho OAuth revoke");
}

async function fetchZohoUserInfo(accessToken, region) {
	const parsed = await httpsJson({
		url: `${region.accounts}/oauth/user/info`,
		method: "GET",
		headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
		label: "Zoho user-info"
	});
	const email = parsed.Email || parsed.email;
	if (!email) throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Could not determine the Zoho account's email.", 401);
	return {
		email: String(email).toLowerCase().trim(),
		displayName: parsed.Display_Name || parsed.display_name || null,
		zuid: parsed.ZUID ? String(parsed.ZUID) : null
	};
}

// ---- AES-256-GCM for tokens stored at rest ---------------------------------------

function encryptionKey() {
	const secret = requireEnv("TOKEN_ENCRYPTION_KEY", 32);
	if (secret === String(process.env.STATE_SIGNING_SECRET || "").trim()) {
		console.error("[config] TOKEN_ENCRYPTION_KEY and STATE_SIGNING_SECRET must be different values.");
		throw new WorkdriveError("CONFIG_ERROR", "Server configuration error.", 500);
	}
	return crypto.createHash("sha256").update(secret).digest();
}

function encryptToken(plainText) {
	if (!plainText) return "";
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
	const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptToken(encoded) {
	if (!encoded) return null;
	const raw = Buffer.from(encoded, "base64");
	if (raw.length < 28) throw new WorkdriveError("WORKDRIVE_NOT_CONNECTED", "Stored token is malformed. Please reconnect.", 403);
	const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), raw.subarray(0, 12));
	decipher.setAuthTag(raw.subarray(12, 28));
	try {
		return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
	} catch {
		throw new WorkdriveError("WORKDRIVE_NOT_CONNECTED", "Stored token could not be read. Please reconnect.", 403);
	}
}

module.exports = {
	buildAuthorizeUrl,
	signState,
	verifyState,
	exchangeCodeForToken,
	refreshAccessToken,
	revokeToken,
	fetchZohoUserInfo,
	encryptToken,
	decryptToken,
	sha256Hex,
	safeEqual,
	WORKDRIVE_SCOPES
};
