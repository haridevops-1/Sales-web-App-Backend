"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireSession, decodeSession, WorkdriveError, toErrorResponse, workdrive, auth;

try {
	({ requireSession, decodeSession } = require("./shared-workdrive/utils/session"));
	({ WorkdriveError, toErrorResponse } = require("./shared-workdrive/utils/errors"));
	workdrive = require("./shared-workdrive/services/workdrive");
	auth = require("./shared-workdrive/services/auth");
} catch {
	({ requireSession, decodeSession } = require("../../shared-workdrive/utils/session"));
	({ WorkdriveError, toErrorResponse } = require("../../shared-workdrive/utils/errors"));
	workdrive = require("../../shared-workdrive/services/workdrive");
	auth = require("../../shared-workdrive/services/auth");
}

// Alphanumeric ID validation regex for Zoho WorkDrive IDs (folder_id, file_id)
const WORKDRIVE_ID_REGEX = /^[a-zA-Z0-9_-]{10,64}$/;

function isValidWorkdriveId(id) {
	if (!id || typeof id !== "string") return false;
	return WORKDRIVE_ID_REGEX.test(id.trim());
}

function sanitizeSearchQuery(query) {
	if (!query) return "";
	return String(query)
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/['"<>\\;]/g, "")
		.trim()
		.slice(0, 100);
}

const ALLOWED_ORIGINS = [
	"https://spikra-ai-proposal-app.onslate.com",
	"http://localhost:5173",
	"http://localhost:3000",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:3000"
];

function setSecurityAndCorsHeaders(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".onslate.com") || origin.endsWith(".zohocatalyst.com") || origin.endsWith(".zohocatalyst.in")) {
		res.setHeader("Access-Control-Allow-Origin", origin);
	} else if (!origin) {
		res.setHeader("Access-Control-Allow-Origin", "*");
	} else {
		res.setHeader("Access-Control-Allow-Origin", origin);
	}

	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Workdrive-Token, X-Session-Token, session_token");
	res.setHeader("Access-Control-Allow-Credentials", "true");

	// Standard security headers on every response
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
	res.end(JSON.stringify(payload));
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
		setSecurityAndCorsHeaders(req, res);

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
		const queryAction = urlObj.searchParams.get("action") || (req.query && req.query.action);
		const pathname = (req.url || "").split("?")[0].toLowerCase();

		const code = urlObj.searchParams.get("code");
		const state = urlObj.searchParams.get("state");
		const oauthError = urlObj.searchParams.get("error");

		if (code || state || oauthError || rawPath.includes("/callback") || headerSource.includes("/callback")) {
			action = "callback";
		} else if (queryAction === "search" || pathname.endsWith("/search") || rawPath.includes("/search")) {
			action = "search";
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
			// Anonymous-friendly route: checking status before connecting returns connected: false
			let session = null;
			try {
				session = requireSession(req);
			} catch {
				sendJson(res, 200, { success: true, connected: false, provider: "Zoho WorkDrive" });
				return;
			}
			const status = await workdrive.checkConnectionStatus(app, session.email, session);
			sendJson(res, 200, { success: true, ...status });
			return;
		}

		// Search handler with input sanitization and lean payload projection
		if (req.method === "GET" && action === "search") {
			try {
				const session = await decodeSession(req);
				if (!session || (!session.accessToken && !session.email)) {
					return sendJson(res, 401, {
						success: false,
						error: { code: "WORKDRIVE_AUTH_FAILED", message: "WorkDrive session is invalid or expired." }
					});
				}

				const rawQuery = urlObj.searchParams.get("query") || (req.query && req.query.query) || "";
				const query = sanitizeSearchQuery(rawQuery);
				const rawFolderId = urlObj.searchParams.get("folder_id") || (req.query && req.query.folder_id);
				const folderId = rawFolderId ? String(rawFolderId).trim() : null;

				if (folderId && !isValidWorkdriveId(folderId)) {
					return sendJson(res, 400, {
						success: false,
						error: { code: "INVALID_FOLDER_ID", message: "Malformed folder identifier." }
					});
				}

				const result = await workdrive.searchWorkDriveItems({ session, query, folderId, app });
				return sendJson(res, 200, {
					success: true,
					query: result.query,
					folderId: result.folderId,
					items: result.items
				});
			} catch (err) {
				console.error("[WorkDrive Search Error]:", err.message);
				const statusCode = err.statusCode || (err.name === "WorkdriveError" ? err.statusCode : 500);
				return sendJson(res, statusCode || 500, {
					success: false,
					error: { code: err.code || "SEARCH_FAILED", message: err.message || "Failed to search Zoho WorkDrive." }
				});
			}
		}

		// Every subsequent action requires a valid session
		const session = requireSession(req);

		if (req.method === "POST" && action === "disconnect") {
			const result = await workdrive.disconnectConnection(app, session.email, session);
			sendJson(res, 200, { success: true, ...result });
			return;
		}

		if (req.method === "GET" && action === "list") {
			const rawFolderId = urlObj.searchParams.get("folder_id") || (req.query && req.query.folder_id);
			const folderId = rawFolderId ? String(rawFolderId).trim() : null;

			if (folderId && !isValidWorkdriveId(folderId)) {
				return sendJson(res, 400, {
					success: false,
					error: { code: "INVALID_FOLDER_ID", message: "Malformed folder identifier." }
				});
			}

			const rawItems = folderId
				? await workdrive.listFiles(app, session.email, folderId, session)
				: await workdrive.listRootItems(app, session.email, session);

			const items = Array.isArray(rawItems) ? rawItems.map(workdrive.normalizeItem).filter(Boolean) : [];
			sendJson(res, 200, { success: true, folder_id: folderId || null, items });
			return;
		}

		if (req.method === "GET" && action === "metadata") {
			const rawFileId = urlObj.searchParams.get("file_id") || (req.query && req.query.file_id);
			const fileId = rawFileId ? String(rawFileId).trim() : null;

			if (!fileId || !isValidWorkdriveId(fileId)) {
				return sendJson(res, 400, {
					success: false,
					error: { code: "INVALID_FILE_ID", message: "Malformed file identifier." }
				});
			}

			const metadata = await workdrive.getFileMetadata(app, session.email, fileId, session);
			if (!metadata) throw new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "This WorkDrive file could not be found.", 404);
			sendJson(res, 200, { success: true, file: workdrive.normalizeItem(metadata) || metadata });
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
	const location = (urlObj.searchParams.get("location") || "").toLowerCase();
	let accountsServer = urlObj.searchParams.get("accounts-server") || urlObj.searchParams.get("accounts_server") || null;

	if (!accountsServer && (location === "in" || location.includes("in"))) {
		accountsServer = "https://accounts.zoho.in";
	} else if (!accountsServer && (location === "eu" || location.includes("eu"))) {
		accountsServer = "https://accounts.zoho.eu";
	}

	if (oauthError) {
		console.error("[WorkDrive Auth] OAuth provider returned error in callback:", oauthError);
		return sendCallbackResult(res, false, `Zoho authorization was denied or failed: ${oauthError}`);
	}
	if (!code) {
		console.error("[WorkDrive Auth] Missing authorization code in callback.");
		return sendCallbackResult(res, false, "Missing authorization code from Zoho.");
	}
	if (state && !auth.verifyState(state)) {
		console.warn("[WorkDrive Auth] State verification warning (possibly expired nonce):", auth.maskToken(state));
	}

	try {
		console.log("[WorkDrive Auth] Exchanging grant code with accounts server:", accountsServer || "default");
		const tokenResponse = await auth.exchangeCodeForToken(code, accountsServer);
		const userApiDomain = tokenResponse.api_domain ? `${tokenResponse.api_domain.replace(/\/+$/, "")}/workdrive/api/v1` : null;

		console.log("[WorkDrive Auth] Code exchanged. Fetching user info...");
		const { email, displayName } = await auth.fetchZohoUserInfo(tokenResponse.access_token, accountsServer, userApiDomain);

		console.log("[WorkDrive Auth] Successfully authenticated user:", email);
		await workdrive.upsertConnection(app, {
			email,
			displayName,
			accessToken: tokenResponse.access_token,
			refreshToken: tokenResponse.refresh_token,
			expiresIn: tokenResponse.expires_in,
			scope: tokenResponse.scope || auth.WORKDRIVE_SCOPES,
			apiDomain: userApiDomain
		});

		const sessionToken = auth.issueSessionToken({
			email,
			displayName,
			accessToken: tokenResponse.access_token,
			refreshToken: tokenResponse.refresh_token,
			expiresIn: tokenResponse.expires_in,
			scope: tokenResponse.scope || auth.WORKDRIVE_SCOPES,
			apiDomain: userApiDomain
		});
		console.log("[WorkDrive Auth] Session issued successfully for:", email, "Token:", auth.maskToken(sessionToken));
		sendCallbackResult(res, true, `WorkDrive connected successfully as ${email}.`, sessionToken, email);
	} catch (err) {
		console.error("[WorkDrive Auth] Callback handling failed:", err?.message || err);
		sendCallbackResult(res, false, `Failed to complete WorkDrive authorization: ${err?.message || "Internal error"}`);
	}
}

// Plain HTML response (this is a browser navigation, not an API call the frontend reads
// directly). Hands the session token back to the opener window via postMessage - the
// frontend stores it and sends it as "Authorization: Bearer <token>" from then on.
function sendCallbackResult(res, success, message, sessionToken, email) {
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");

	const closeButtonHtml = !success ? '<button onclick="window.close()" style="margin-top:16px;padding:8px 16px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;">Close Window</button>' : '';
	res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WorkDrive Connection</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;padding:32px;max-width:520px;background:#ffffff;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.08);">
<h2 style="color:${success ? "#16a34a" : "#dc2626"};margin-top:0;">${success ? "Connected Successfully" : "Connection Failed"}</h2>
<p style="color:#475569;font-size:15px;line-height:1.5;word-break:break-word;">${escapeHtml(message)}</p>
<div id="returnBox" style="margin-top:20px;display:none;">
  <a id="returnLink" href="http://localhost:5173/proposals/create" style="display:inline-block;padding:10px 20px;background:#ea580c;color:#fff;text-decoration:none;font-weight:600;border-radius:8px;">
    Return to Spikra Application →
  </a>
</div>
<script>
try {
  const sessionToken = ${sessionToken ? JSON.stringify(sessionToken) : "null"};
  const userEmail = ${email ? JSON.stringify(email) : "null"};
  const isSuccess = ${success ? "true" : "false"};

  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({
      type: "workdrive-auth",
      success: isSuccess,
      sessionToken: sessionToken,
      email: userEmail,
      error: isSuccess ? null : ${JSON.stringify(message)},
      message: ${JSON.stringify(message)}
    }, "*");
    if (isSuccess) {
      setTimeout(() => window.close(), 600);
    } else {
      setTimeout(() => window.close(), 6000);
    }
  } else {
    if (isSuccess && sessionToken) {
      const returnBox = document.getElementById("returnBox");
      const returnLink = document.getElementById("returnLink");
      if (returnBox && returnLink) {
        const targetUrl = new URL("http://localhost:5173/proposals/create");
        targetUrl.searchParams.set("session_token", sessionToken);
        if (userEmail) targetUrl.searchParams.set("email", userEmail);
        returnLink.href = targetUrl.toString();
        returnBox.style.display = "block";
        setTimeout(() => { window.location.href = targetUrl.toString(); }, 1200);
      }
    }
  }
} catch (e) {
  console.error("Callback completion error:", e);
}
</script>
${closeButtonHtml}
</div></body></html>`);
}

function escapeHtml(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
