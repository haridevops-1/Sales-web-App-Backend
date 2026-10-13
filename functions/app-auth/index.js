"use strict";

// Application sign-in with Zoho Accounts (OAuth 2.0 authorization-code flow). Zoho's own
// login page is the identity check; the account's email must belong to an allowed domain.
// A successful login opens a server-side session (APP_SESSIONS) and the browser is sent back
// to the app with the opaque session token in the URL *fragment* (never sent to any server).

const catalyst = require("zcatalyst-sdk-node");
const { requireSession, extractSessionToken } = require("./shared-auth/utils/session");
const { WorkdriveError, toErrorResponse } = require("./shared-auth/utils/errors");
const { getAllowedOrigins, allowedOriginOrNull, emailDomainAllowed, resolveRegion } = require("./shared-auth/utils/config");
const auth = require("./shared-auth/services/auth");
const users = require("./shared-auth/services/users");
const workdrive = require("./shared-auth/services/workdrive");

const ACTIONS = new Set(["login", "callback", "me", "logout"]);

function setHeaders(req, res) {
	// The gateway already sets Access-Control-Allow-Origin for Authorised Domains.
	if (allowedOriginOrNull(req.headers && req.headers.origin)) {
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
		res.setHeader("Access-Control-Max-Age", "86400");
		res.setHeader("Vary", "Origin");
	}
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

function redirect(res, location) {
	res.statusCode = 302;
	res.setHeader("Location", location);
	res.end();
}

function resolveAction(urlObj) {
	const fromQuery = String(urlObj.searchParams.get("action") || "").toLowerCase();
	if (ACTIONS.has(fromQuery)) return fromQuery;
	const last = urlObj.pathname.replace(/\/+$/, "").split("/").pop().toLowerCase();
	return ACTIONS.has(last) ? last : null;
}

module.exports = async (req, res) => {
	try {
		setHeaders(req, res);
		getAllowedOrigins();

		if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

		const app = catalyst.initialize(req);
		const urlObj = new URL(req.url, "http://localhost");
		const action = resolveAction(urlObj);
		if (!action) throw new WorkdriveError("NOT_FOUND", "Unknown endpoint.", 404);

		if (req.method === "GET" && action === "login") {
			const candidate = urlObj.searchParams.get("return_to") || (req.headers && req.headers.origin) || (req.headers && req.headers.referer);
			const url = auth.buildAuthorizeUrl({ purpose: "login", regionInput: urlObj.searchParams.get("dc"), clientOrigin: candidate });
			if (urlObj.searchParams.get("format") === "json") return sendJson(res, 200, { success: true, authorize_url: url });
			return redirect(res, url);
		}

		if (req.method === "GET" && action === "callback") return await handleCallback(app, urlObj, res);

		if (req.method === "GET" && action === "me") {
			const user = await requireSession(app, req);
			const wd = await workdrive.getConnectionStatus(app, user);
			return sendJson(res, 200, {
				success: true,
				user: { email: user.email, displayName: user.displayName },
				workdrive: { connected: wd.connected, account: wd.account }
			});
		}

		if (req.method === "POST" && action === "logout") {
			if (!extractSessionToken(req)) return sendJson(res, 200, { success: true });
			const user = await requireSession(app, req);
			await users.revokeSession(app, user);
			return sendJson(res, 200, { success: true });
		}

		throw new WorkdriveError("VALIDATION_FAILED", "Unsupported method/action combination.", 405);
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error);
		if (statusCode >= 500) console.error("[app-auth] Request failed:", error && error.message);
		sendJson(res, statusCode, body);
	}
};

function failPage(res, message) {
	res.statusCode = 400;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
	const safe = String(message).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sign-in</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7f9fa"><div style="max-width:460px;text-align:center;padding:24px"><h2>Sign-in failed</h2><p style="color:#6b7c87">${safe}</p></div></body></html>`);
}

// Zoho redirects the browser here. A valid signed state is mandatory: it proves the flow
// started at /auth/login and names the single allow-listed origin to return to.
async function handleCallback(app, urlObj, res) {
	const state = auth.verifyState(urlObj.searchParams.get("state"), "login");
	if (!state) return failPage(res, "This sign-in link is invalid or has expired. Return to the app and try again.");

	const back = (fragment) => redirect(res, `${state.origin}/#${fragment}`);

	if (urlObj.searchParams.get("error")) return back("sp_error=access_denied");
	const code = urlObj.searchParams.get("code");
	if (!code) return back("sp_error=login_failed");

	try {
		const accountsServer = urlObj.searchParams.get("accounts-server");
		const region = accountsServer ? resolveRegion(accountsServer) : state.region;

		const tokens = await auth.exchangeCodeForToken(code, region, "login");
		const profile = await auth.fetchZohoUserInfo(tokens.access_token, region);

		if (!emailDomainAllowed(profile.email)) {
			console.warn("[app-auth] Sign-in rejected: email domain not allowed.");
			return back("sp_error=not_allowed");
		}

		const session = await users.loginUser(app, profile);
		return back("sp_token=" + encodeURIComponent(session.token));
	} catch (err) {
		console.error("[app-auth] Sign-in failed:", err && err.message);
		return back(err && err.code === "FORBIDDEN" ? "sp_error=disabled" : "sp_error=login_failed");
	}
}
