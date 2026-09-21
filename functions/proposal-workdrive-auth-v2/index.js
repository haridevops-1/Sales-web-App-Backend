"use strict";

const catalyst = require("zcatalyst-sdk-node");

let ProposalError, toErrorResponse, workdrive, auth, logEvent, newRequestId, requireWorkdriveSession;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	workdrive = require("./shared/services/workdrive");
	auth = require("./shared/services/auth");
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	workdrive = require("../../workspace2-proposal/services/workdrive");
	auth = require("../../workspace2-proposal/services/auth");
}

// No Catalyst login anywhere in this function. Clicking "Open WorkDrive" goes straight
// to Zoho's own login/consent page - Zoho's login IS the identity check. Once it
// succeeds, we look up the salesperson's email (Zoho's own user-info endpoint), store
// their OAuth token (never their password - it's entered only on Zoho's page and never
// reaches us) in WORKDRIVE_LOGIN, and hand the frontend a signed session token so later
// requests know who they are. Folder/file browsing (once connected) is exposed through
// proposal-api, which calls the same workspace2-proposal/services/workdrive module.
module.exports = async (req, res) => {
	const requestId = newRequestId();
	let route = "unknown";

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== "GET" && req.method !== "POST") {
			sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Only GET and POST requests are supported." } });
			return;
		}

		const app = catalyst.initialize(req);
		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		// Advanced I/O functions behind the API Gateway all resolve to the same fixed
		// target endpoint regardless of source_endpoint - req.url's pathname is stripped
		// to "/" either way (confirmed live). Routing uses the query string instead.
		const code = urlObj.searchParams.get("code");
		const state = urlObj.searchParams.get("state");
		const oauthError = urlObj.searchParams.get("error");
		const action = String(urlObj.searchParams.get("action") || "status").toLowerCase();

		if (req.method === "GET" && (code || state || oauthError)) {
			route = "callback";
			await handleCallback(app, urlObj, res, requestId);
			return;
		}

		route = action;

		if (req.method === "GET" && route === "authorize") {
			const authorizeUrl = auth.buildAuthorizeUrl();
			sendJson(res, 200, { success: true, authorize_url: authorizeUrl });
			logEvent("proposal-workdrive-auth-v2", { requestId, operation: "authorize", status: "success" });
			return;
		}

		if (req.method === "POST" && route === "disconnect") {
			const session = await requireWorkdriveSession(req);
			const result = await workdrive.disconnectLogin(app, session.email);
			sendJson(res, 200, { success: true, ...result });
			logEvent("proposal-workdrive-auth-v2", { requestId, operation: "disconnect", status: "success" });
			return;
		}

		if (req.method !== "GET") {
			sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Unsupported method/action combination." } });
			return;
		}

		// status: no session yet just means "not connected," not an error - lets the
		// frontend freely check before deciding whether to show the connect button.
		let session = null;
		try {
			session = await requireWorkdriveSession(req);
		} catch {}

		if (!session) {
			sendJson(res, 200, { success: true, connected: false, provider: "Zoho WorkDrive" });
			return;
		}

		const status = await workdrive.checkConnectionStatus(app, session.email);
		sendJson(res, 200, { success: true, ...status });
		logEvent("proposal-workdrive-auth-v2", { requestId, operation: "status", status: "success" });
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error, requestId);
		sendJson(res, statusCode, body);
		logEvent("proposal-workdrive-auth-v2", {
			requestId,
			operation: route,
			status: "failed",
			errorCode: body.error && body.error.code
		});
	}
};

// The callback is a browser redirect target from Zoho's own consent page. `state` only
// proves this round trip started from a browser that actually clicked "authorize"
// (CSRF protection) - it carries no identity, since none exists yet. Identity comes
// from Zoho's own user-info endpoint, using the token we just received.
async function handleCallback(app, urlObj, res, requestId) {
	const code = urlObj.searchParams.get("code");
	const state = urlObj.searchParams.get("state");
	const oauthError = urlObj.searchParams.get("error");

	if (oauthError) {
		return sendCallbackResult(res, false, `WorkDrive authorization was not completed: ${oauthError}`);
	}
	if (!code || !state) {
		return sendCallbackResult(res, false, "Missing authorization code or state.");
	}
	if (!auth.verifyState(state)) {
		return sendCallbackResult(res, false, "This authorization link is invalid or has expired. Please try connecting again.");
	}

	try {
		const tokenResponse = await auth.exchangeCodeForToken(code);
		const { email, displayName } = await auth.fetchZohoUserInfo(tokenResponse.access_token);

		await workdrive.upsertLogin(app, {
			email,
			displayName,
			accessToken: tokenResponse.access_token,
			refreshToken: tokenResponse.refresh_token,
			expiresIn: tokenResponse.expires_in,
			scope: tokenResponse.scope || auth.WORKDRIVE_SCOPES
		});

		const sessionToken = auth.issueSessionToken(email);
		logEvent("proposal-workdrive-auth-v2", { requestId, operation: "callback", status: "success" });
		sendCallbackResult(res, true, `WorkDrive connected as ${email}. You can close this window.`, sessionToken, email);
	} catch (err) {
		logEvent("proposal-workdrive-auth-v2", { requestId, operation: "callback", status: "failed", errorCode: err.code });
		sendCallbackResult(res, false, "Failed to complete WorkDrive authorization. Please try again.");
	}
}

// Plain HTML response (this is a browser navigation, not an API call the frontend reads
// directly). Hands the session token back to the opener window via postMessage - the
// frontend stores it and sends it as "Authorization: Bearer <token>" from then on.
function sendCallbackResult(res, success, message, sessionToken, email) {
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WorkDrive Connection</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;padding:24px;">
<h2 style="color:${success ? "#16a34a" : "#dc2626"};">${success ? "Connected" : "Connection Failed"}</h2>
<p style="color:#475569;">${escapeHtml(message)}</p>
<script>
try {
  if (window.opener) {
    window.opener.postMessage({ type: "workdrive-auth", success: ${success ? "true" : "false"}, sessionToken: ${sessionToken ? JSON.stringify(sessionToken) : "null"}, email: ${email ? JSON.stringify(email) : "null"} }, "*");
    window.close();
  }
} catch (e) {}
</script>
</div></body></html>`);
}

function escapeHtml(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function setCorsHeaders(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (origin !== "https://spikra-ai-proposal-app.onslate.com") {
		res.setHeader("Access-Control-Allow-Origin", origin || "*");
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
