"use strict";

// Zoho WorkDrive connection for the signed-in app user. This is separate from app sign-in:
// the user approves WorkDrive access once, the encrypted refresh token is stored in their
// WORKDRIVE_CONNECTIONS row, and they are not asked again until they disconnect.
//
// Connect flow (browser redirect, no popup):
//   1. GET  /workdrive/authorize  (signed in) -> { authorize_url, binding }. The state is signed and
//      bound to the user and to sha256(binding); the browser keeps `binding` privately.
//   2. Zoho redirects to GET /workdrive/callback, which only forwards the one-time code to the
//      allow-listed app origin inside the URL fragment.
//   3. POST /workdrive/connect { code, state, binding } (signed in) verifies the state, the user
//      and the binding, then exchanges the code. A forged link cannot attach someone else's
//      WorkDrive to an account because it cannot supply the matching binding.

const crypto = require("crypto");
const catalyst = require("zcatalyst-sdk-node");
const { requireSession } = require("./shared-auth/utils/session");
const { WorkdriveError, toErrorResponse } = require("./shared-auth/utils/errors");
const { getAllowedOrigins, allowedOriginOrNull, resolveRegion } = require("./shared-auth/utils/config");
const auth = require("./shared-auth/services/auth");
const workdrive = require("./shared-auth/services/workdrive");

const ACTIONS = new Set(["status", "authorize", "callback", "connect", "disconnect", "list", "metadata"]);
const WORKDRIVE_ID_REGEX = /^[a-zA-Z0-9_-]{10,64}$/;
const MAX_BODY_BYTES = 16 * 1024;

const isValidWorkdriveId = (id) => typeof id === "string" && WORKDRIVE_ID_REGEX.test(id.trim());

function sanitizeSearchQuery(query) {
	return String(query || "").replace(/[\x00-\x1f\x7f]/g, "").replace(/['"<>\\;]/g, "").trim().slice(0, 100);
}

function setHeaders(req, res) {
	// The gateway already sets Access-Control-Allow-Origin for Authorised Domains.
	if (allowedOriginOrNull(req.headers && req.headers.origin)) {
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Token, Accept");
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

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return resolve(req.body);
		const parse = (raw) => {
			try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new WorkdriveError("VALIDATION_FAILED", "Request body must be valid JSON.", 400)); }
		};
		if (Buffer.isBuffer(req.body)) return parse(req.body.toString("utf8"));
		if (typeof req.body === "string") return parse(req.body);
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) { req.destroy(); return reject(new WorkdriveError("VALIDATION_FAILED", "Request body is too large.", 413)); }
			chunks.push(chunk);
		});
		req.on("end", () => parse(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function resolveAction(urlObj) {
	const fromQuery = String(urlObj.searchParams.get("action") || "").toLowerCase();
	if (ACTIONS.has(fromQuery)) return fromQuery;
	const last = urlObj.pathname.replace(/\/+$/, "").split("/").pop().toLowerCase();
	if (ACTIONS.has(last)) return last;
	// Zoho's redirect carries code/error + state and no action parameter.
	if (urlObj.searchParams.get("state") && (urlObj.searchParams.get("code") || urlObj.searchParams.get("error"))) return "callback";
	return null;
}

module.exports = async (req, res) => {
	try {
		setHeaders(req, res);
		getAllowedOrigins();

		if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
		if (req.method !== "GET" && req.method !== "POST") {
			throw new WorkdriveError("VALIDATION_FAILED", "Only GET and POST requests are supported.", 405);
		}

		const app = catalyst.initialize(req);
		const urlObj = new URL(req.url, "http://localhost");
		const action = resolveAction(urlObj);
		if (!action) throw new WorkdriveError("NOT_FOUND", "Unknown WorkDrive endpoint.", 404);

		if (req.method === "GET" && action === "callback") return handleCallback(urlObj, res);

		const user = await requireSession(app, req);

		if (req.method === "GET" && action === "authorize") {
			const binding = crypto.randomBytes(32).toString("base64url");
			const authorizeUrl = auth.buildAuthorizeUrl({
				purpose: "workdrive",
				regionInput: urlObj.searchParams.get("dc"),
				clientOrigin: req.headers && req.headers.origin,
				extra: { u: user.email, b: auth.sha256Hex(binding) }
			});
			return sendJson(res, 200, { success: true, authorize_url: authorizeUrl, binding });
		}

		if (req.method === "POST" && action === "connect") return await handleConnect(app, user, req, res);

		if (req.method === "GET" && action === "status") {
			return sendJson(res, 200, { success: true, ...(await workdrive.getConnectionStatus(app, user)) });
		}

		if (req.method === "POST" && action === "disconnect") {
			return sendJson(res, 200, { success: true, ...(await workdrive.disconnectConnection(app, user)) });
		}

		if (req.method === "GET" && action === "list") {
			const folderId = String(urlObj.searchParams.get("folder_id") || "").trim() || null;
			if (folderId && !isValidWorkdriveId(folderId)) throw new WorkdriveError("INVALID_FOLDER_ID", "Malformed folder identifier.", 400);

			const query = !folderId ? sanitizeSearchQuery(urlObj.searchParams.get("query")) : "";
			if (query) {
				const match = await workdrive.findBusinessFolder(app, user, query);
				if (!match) return sendJson(res, 200, { success: true, matched: false, folder_id: null, items: [] });
				const children = await workdrive.listFiles(app, user, match.folder.id);
				return sendJson(res, 200, {
					success: true,
					matched: true,
					folder_id: match.folder.id,
					folder_name: match.folder.name,
					breadcrumb: match.breadcrumb.map((b) => ({ id: b.id, name: b.name })),
					items: children.map(workdrive.normalizeItem).filter(Boolean)
				});
			}

			const raw = folderId ? await workdrive.listFiles(app, user, folderId) : await workdrive.listRootItems(app, user);
			return sendJson(res, 200, { success: true, folder_id: folderId, items: raw.map(workdrive.normalizeItem).filter(Boolean) });
		}

		if (req.method === "GET" && action === "metadata") {
			const fileId = String(urlObj.searchParams.get("file_id") || "").trim();
			if (!isValidWorkdriveId(fileId)) throw new WorkdriveError("INVALID_FILE_ID", "Malformed file identifier.", 400);
			const metadata = await workdrive.getFileMetadata(app, user, fileId);
			if (!metadata) throw new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "This WorkDrive file could not be found.", 404);
			return sendJson(res, 200, { success: true, file: workdrive.normalizeItem(metadata) });
		}

		throw new WorkdriveError("VALIDATION_FAILED", "Unsupported method/action combination.", 405);
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error);
		if (statusCode >= 500) console.error("[WorkDrive] Request failed:", error && error.message);
		sendJson(res, statusCode, body);
	}
};

function failPage(res, message) {
	res.statusCode = 400;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
	const safe = String(message).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WorkDrive</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7f9fa"><div style="max-width:460px;text-align:center;padding:24px"><h2>WorkDrive connection failed</h2><p style="color:#6b7c87">${safe}</p></div></body></html>`);
}

// Zoho redirects the browser here. Nothing is stored; the one-time code is only handed to
// the allow-listed app origin named in the signed state, inside the URL fragment.
function handleCallback(urlObj, res) {
	const state = auth.verifyState(urlObj.searchParams.get("state"), "workdrive");
	if (!state) return failPage(res, "This link is invalid or has expired. Return to the app and try again.");

	let fragment;
	const code = urlObj.searchParams.get("code");
	if (urlObj.searchParams.get("error") || !code) {
		fragment = "wd_error=access_denied";
	} else {
		fragment = `wd_code=${encodeURIComponent(code)}&wd_state=${encodeURIComponent(urlObj.searchParams.get("state"))}` +
			`&wd_server=${encodeURIComponent(urlObj.searchParams.get("accounts-server") || "")}`;
	}
	res.statusCode = 302;
	res.setHeader("Location", `${state.origin}/#${fragment}`);
	res.end();
}

async function handleConnect(app, user, req, res) {
	const body = await readJsonBody(req);
	const code = String(body.code || "").trim();
	const binding = String(body.binding || "");
	const state = auth.verifyState(body.state, "workdrive");

	if (!code || !binding || !state || state.u !== user.email || !auth.safeEqual(state.b, auth.sha256Hex(binding))) {
		throw new WorkdriveError("VALIDATION_FAILED", "This connection attempt is invalid or has expired. Please try again.", 400);
	}

	const region = body.accounts_server ? resolveRegion(body.accounts_server) : state.region;
	const tokens = await auth.exchangeCodeForToken(code, region, "workdrive");
	if (!tokens.access_token || !tokens.refresh_token) {
		console.error("[WorkDrive] Token reply missing:", !tokens.access_token ? "access_token" : "", !tokens.refresh_token ? "refresh_token" : "");
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "Zoho did not return the expected tokens. Please click Connect WorkDrive again and approve the access screen.", 502);
	}
	const account = await auth.fetchZohoUserInfo(tokens.access_token, region);

	await workdrive.saveConnection(app, user, {
		wdEmail: account.email,
		displayName: account.displayName,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresIn: tokens.expires_in,
		scope: tokens.scope || auth.WORKDRIVE_SCOPES,
		regionKey: region.key
	});
	sendJson(res, 200, { success: true, connected: true, provider: "Zoho WorkDrive", account: { email: account.email, displayName: account.displayName } });
}
