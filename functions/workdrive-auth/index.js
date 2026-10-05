"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireSession, WorkdriveError, toErrorResponse, workdrive, auth;

try {
	({ requireSession } = require("./shared-workdrive/utils/session"));
	({ WorkdriveError, toErrorResponse } = require("./shared-workdrive/utils/errors"));
	workdrive = require("./shared-workdrive/services/workdrive");
	auth = require("./shared-workdrive/services/auth");
} catch {
	({ requireSession } = require("../../shared-workdrive/utils/session"));
	({ WorkdriveError, toErrorResponse } = require("../../shared-workdrive/utils/errors"));
	workdrive = require("../../shared-workdrive/services/workdrive");
	auth = require("../../shared-workdrive/services/auth");
}

// No Catalyst login anywhere in this function. Clicking "Open WorkDrive" goes straight
// to Zoho's own login/consent page - Zoho's login IS the identity check. Once it
// succeeds, we look up the salesperson's email (Zoho's own user-info endpoint), store
// their OAuth token (never their password - it's entered only on Zoho's page and never
// reaches us) in WORKDRIVE_CONNECTIONS, and hand the frontend a signed session token so
// later requests know who they are. Shared by both Workspace 1 and Workspace 2 - a
// salesperson's WorkDrive connection is the same regardless of which pipeline uses it.
module.exports = async (req, res) => {
	let action = "unknown";

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
		
		// Robust action detection: works whether invoked via query param, API gateway path, or direct function path
		const rawPath = String(req.url || urlObj.pathname || "").toLowerCase();
		const headerSource = String(req.headers["x-catalyst-source-url"] || req.headers["x-original-url"] || "").toLowerCase();
		const queryAction = urlObj.searchParams.get("action");

		const code = urlObj.searchParams.get("code");
		const state = urlObj.searchParams.get("state");
		const oauthError = urlObj.searchParams.get("error");

		if (code || state || oauthError || rawPath.includes("/callback") || headerSource.includes("/callback")) {
			action = "callback";
		} else if (queryAction) {
			action = String(queryAction).toLowerCase();
		} else if (rawPath.includes("/authorize") || headerSource.includes("/authorize")) {
			action = "authorize";
		} else if (rawPath.includes("/disconnect") || headerSource.includes("/disconnect")) {
			action = "disconnect";
		} else if (rawPath.includes("/list") || headerSource.includes("/list")) {
			action = "list";
		} else if (rawPath.includes("/metadata") || headerSource.includes("/metadata")) {
			action = "metadata";
		} else {
			action = "status";
		}

		if (req.method === "GET" && action === "callback") {
			await handleCallback(app, urlObj, res);
			return;
		}

		if (req.method === "GET" && action === "authorize") {
			const reqDc = String(urlObj.searchParams.get("dc") || urlObj.searchParams.get("domain") || "").toLowerCase();
			let customAccountsDomain = null;
			if (reqDc === "in" || reqDc.includes(".zoho.in")) {
				customAccountsDomain = "https://accounts.zoho.in";
			} else if (reqDc === "eu" || reqDc.includes(".zoho.eu")) {
				customAccountsDomain = "https://accounts.zoho.eu";
			} else if (reqDc === "com" || reqDc.includes(".zoho.com")) {
				customAccountsDomain = "https://accounts.zoho.com";
			} else if (reqDc.startsWith("http")) {
				customAccountsDomain = reqDc;
			}

			const authorizeUrl = auth.buildAuthorizeUrl(customAccountsDomain);
			const format = String(urlObj.searchParams.get("format") || "").toLowerCase();
			const accept = String(req.headers["accept"] || "").toLowerCase();
			// If requested as JSON (e.g. via AJAX/fetch with ?format=json or Accept: application/json), return JSON
			if (format === "json" || (accept.includes("application/json") && !accept.includes("text/html"))) {
				sendJson(res, 200, { success: true, authorize_url: authorizeUrl });
				return;
			}
			// For browser navigations, directly redirect to Zoho OAuth login / consent page
			res.statusCode = 302;
			res.setHeader("Location", authorizeUrl);
			res.setHeader("Cache-Control", "no-store");
			res.end();
			return;
		}

		if (req.method === "GET" && action === "status") {
			// The one deliberately anonymous-friendly route: checking status before a
			// salesperson has ever connected is not an error, it's the normal first call.
			let session = null;
			try {
				session = requireSession(req);
			} catch {
				sendJson(res, 200, { success: true, connected: false, provider: "Zoho WorkDrive" });
				return;
			}
			const status = await workdrive.checkConnectionStatus(app, session.email);
			sendJson(res, 200, { success: true, ...status });
			return;
		}

		// Every other action requires a real, valid session - requireSession() throws a
		// 401-flavored WorkdriveError on anything missing/invalid, which the outer catch
		// turns into a proper 401 response. No default/fallback identity here.
		const session = requireSession(req);

		if (req.method === "POST" && action === "disconnect") {
			const result = await workdrive.disconnectConnection(app, session.email);
			sendJson(res, 200, { success: true, ...result });
			return;
		}

		if (req.method === "GET" && action === "list") {
			const folderId = urlObj.searchParams.get("folder_id");
			const items = folderId
				? await workdrive.listFiles(app, session.email, folderId)
				: await workdrive.listRootItems(app, session.email);
			sendJson(res, 200, { success: true, folder_id: folderId || null, items });
			return;
		}

		if (req.method === "GET" && action === "metadata") {
			const fileId = urlObj.searchParams.get("file_id");
			if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.");
			const metadata = await workdrive.getFileMetadata(app, session.email, fileId);
			if (!metadata) throw new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "This WorkDrive file could not be found.", 404);
			sendJson(res, 200, { success: true, file: metadata });
			return;
		}

		sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Unsupported method/action combination." } });
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error);
		sendJson(res, statusCode, body);
	}
};

// The callback is a browser redirect target from Zoho's own consent page. `state` only
// proves this round trip started from a browser that actually clicked "authorize"
// (CSRF protection) - it carries no identity, since none exists yet. Identity comes
// from Zoho's own user-info endpoint, using the token we just received.
async function handleCallback(app, urlObj, res) {
	const code = urlObj.searchParams.get("code");
	const state = urlObj.searchParams.get("state");
	const oauthError = urlObj.searchParams.get("error");
	const accountsServer = urlObj.searchParams.get("accounts-server") || urlObj.searchParams.get("accounts_server") || null;

	if (oauthError) {
		console.error("[WorkDrive Auth] OAuth provider returned error in callback:", oauthError);
		return sendCallbackResult(res, false, `WorkDrive authorization was not completed: ${oauthError}`);
	}
	if (!code || !state) {
		console.error("[WorkDrive Auth] Missing authorization code or state in callback. Query:", urlObj.search);
		return sendCallbackResult(res, false, "Missing authorization code or state.");
	}
	if (!auth.verifyState(state)) {
		console.error("[WorkDrive Auth] Invalid or expired state parameter in callback:", state);
		return sendCallbackResult(res, false, "This authorization link is invalid or has expired. Please try connecting again.");
	}

	try {
		const tokenResponse = await auth.exchangeCodeForToken(code, accountsServer);
		const { email, displayName } = await auth.fetchZohoUserInfo(tokenResponse.access_token, accountsServer);

		await workdrive.upsertConnection(app, {
			email,
			displayName,
			accessToken: tokenResponse.access_token,
			refreshToken: tokenResponse.refresh_token,
			expiresIn: tokenResponse.expires_in,
			scope: tokenResponse.scope || auth.WORKDRIVE_SCOPES
		});

		const sessionToken = auth.issueSessionToken(email);
		sendCallbackResult(res, true, `WorkDrive connected as ${email}. You can close this window.`, sessionToken, email);
	} catch (err) {
		console.error("[WorkDrive Auth] Callback handling failed:", err);
		sendCallbackResult(res, false, `Failed to complete WorkDrive authorization: ${err?.message || "Please try again."}`);
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
