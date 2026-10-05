"use strict";

// Zoho WorkDrive API client using PER-SALESPERSON tokens from stateless session tokens,
// in-memory fallback, or WORKDRIVE_CONNECTIONS table if configured.
// Keys by their Zoho email and carries encrypted credentials inside session tokens so
// every function / container instance works reliably without DB dependencies.
// Shared by both Workspace 1 and Workspace 2.

const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { WorkdriveError } = require("../../utils/errors");
const { decryptToken, encryptToken, refreshAccessToken, revokeToken } = require("../auth");

const DEFAULT_API_DOMAIN = "https://www.zohoapis.in/workdrive/api/v1";
const WORKDRIVE_CONNECTIONS_TABLE = "WORKDRIVE_CONNECTIONS";
const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh 2 minutes before actual expiry

// In-memory 30-minute LRU cache for privateSpaceId
const spaceIdCache = new Map(); // Key: sessionHash, Value: { spaceId, expiresAt }

function getSessionHash(session) {
	const token = (session && (session.accessToken || session.email)) || "";
	return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Fast Space ID resolver with 30-minute in-memory cache
 */
async function resolvePrivateSpaceId(session) {
	if (!session) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive session is required to resolve private space.", 401);
	}

	const hash = getSessionHash(session);
	const cached = spaceIdCache.get(hash);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.spaceId;
	}

	const apiDomain = session.apiDomain || getApiDomain(session.email, session);
	const url = `${apiDomain.replace(/\/+$/, "")}/users/me/privatespace`;

	let spaceId = null;
	if (typeof fetch === "function") {
		const res = await fetch(url, {
			headers: {
				Authorization: `Zoho-oauthtoken ${session.accessToken}`,
				Accept: "application/vnd.api+json"
			}
		});

		if (!res.ok) {
			throw new WorkdriveError(
				res.status === 401 ? "WORKDRIVE_TOKEN_EXPIRED" : "WORKDRIVE_API_FAILED",
				`Failed to resolve Private Space: HTTP ${res.status}`,
				res.status
			);
		}

		const json = await res.json();
		const spaceList = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
		spaceId = spaceList[0]?.id;
	} else {
		const json = await request("GET", "/users/me/privatespace", {
			accessToken: session.accessToken,
			email: session.email,
			session
		});
		const spaceList = Array.isArray(json && json.data) ? json.data : (json && json.data ? [json.data] : []);
		spaceId = spaceList[0]?.id;
	}

	if (!spaceId) {
		throw new WorkdriveError("WORKDRIVE_API_FAILED", "No Private Space ID found for user.", 404);
	}

	spaceIdCache.set(hash, { spaceId, expiresAt: Date.now() + 30 * 60 * 1000 });
	return spaceId;
}

/**
 * Normalized Lean Item Formatter
 */
function normalizeItem(raw) {
	if (!raw) return null;
	const attrs = raw.attributes || {};
	const isFolder = raw.type === "files"
		? (attrs.type === "folder" || attrs.is_folder === true)
		: (raw.type === "folder" || raw.type === "workspace" || raw.type === "private_space");

	const ext = attrs.extn ? `.${attrs.extn.replace(/^\./, "")}` : "";
	const size = Number(attrs.storage_info?.size_in_bytes || attrs.size || 0);

	return {
		id: raw.id,
		name: attrs.name || attrs.display_name || "Untitled",
		type: isFolder ? "folder" : "file",
		isFolder,
		size,
		extension: ext,
		modifiedTime: attrs.modified_time_in_millisecond
			? new Date(Number(attrs.modified_time_in_millisecond)).toISOString()
			: (attrs.modified_time || null),
		permalink: attrs.permalink || null
	};
}

/**
 * High-performance search & folder exploration
 */
async function searchWorkDriveItems({ session, query = "", folderId = null, app = null }) {
	if (!session || (!session.accessToken && !session.email)) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive session is invalid or expired.", 401);
	}

	if (!session.accessToken && session.email && app) {
		session.accessToken = await getValidAccessToken(app, session.email, session);
	}
	if (!session.accessToken) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive access token missing in session.", 401);
	}

	const apiDomain = session.apiDomain || getApiDomain(session.email, session);
	const targetFolderId = folderId || (await resolvePrivateSpaceId(session));

	const cleanQuery = String(query || "").trim().replace(/['"<>\\;]/g, "").slice(0, 100);

	let url;
	if (cleanQuery) {
		url = `${apiDomain.replace(/\/+$/, "")}/files/${encodeURIComponent(targetFolderId)}/files?search[name]=${encodeURIComponent(cleanQuery)}&page[limit]=50`;
	} else {
		url = `${apiDomain.replace(/\/+$/, "")}/files/${encodeURIComponent(targetFolderId)}/files?page[limit]=50`;
	}

	let rawItems = [];
	if (typeof fetch === "function") {
		const response = await fetch(url, {
			headers: {
				Authorization: `Zoho-oauthtoken ${session.accessToken}`,
				Accept: "application/vnd.api+json"
			}
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new WorkdriveError(
				response.status === 401 ? "WORKDRIVE_TOKEN_EXPIRED" : "WORKDRIVE_API_FAILED",
				`Zoho API Search error (HTTP ${response.status}): ${errorText.slice(0, 200)}`,
				response.status
			);
		}

		const json = await response.json();
		rawItems = Array.isArray(json && json.data) ? json.data : [];
	} else {
		const qs = cleanQuery ? { "search[name]": cleanQuery, "page[limit]": 50 } : { "page[limit]": 50 };
		const json = await request("GET", `/files/${encodeURIComponent(targetFolderId)}/files`, {
			accessToken: session.accessToken,
			qs,
			email: session.email,
			session
		});
		rawItems = Array.isArray(json && json.data) ? json.data : [];
	}

	return {
		folderId: targetFolderId,
		query: cleanQuery,
		items: rawItems.map(normalizeItem).filter(Boolean)
	};
}

// In-memory fallback map: email -> connection object
const MEMORY_CONNECTIONS = new Map();

function getApiDomain(email, session) {
	if (session && session.apiDomain) return String(session.apiDomain).trim().replace(/\/+$/, "");
	const cached = email ? MEMORY_CONNECTIONS.get(String(email).toLowerCase()) : null;
	if (cached && cached.apiDomain) return String(cached.apiDomain).trim().replace(/\/+$/, "");

	const accountsDomain = String(process.env.ZOHO_ACCOUNTS_DOMAIN || "").toLowerCase();
	if (accountsDomain.includes(".zoho.in")) return "https://www.zohoapis.in/workdrive/api/v1";
	if (accountsDomain.includes(".zoho.eu")) return "https://www.zohoapis.eu/workdrive/api/v1";
	if (accountsDomain.includes(".zoho.com.au")) return "https://www.zohoapis.com.au/workdrive/api/v1";

	const normEmail = String(email || (session && session.email) || "").toLowerCase();
	if (normEmail.includes("spikra") || normEmail.endsWith(".in")) {
		return "https://www.zohoapis.in/workdrive/api/v1";
	}

	return String(process.env.WORKDRIVE_API_DOMAIN || DEFAULT_API_DOMAIN).trim().replace(/\/+$/, "");
}

async function getConnectionRow(app, email) {
	if (!email) return null;
	const normalizedEmail = email.toLowerCase().trim();

	// 1. Try querying Catalyst Data Store via ZCQL (best-effort)
	if (app && typeof app.zcql === "function") {
		const query = `SELECT * FROM ${WORKDRIVE_CONNECTIONS_TABLE} WHERE email = '${escapeQueryValue(normalizedEmail)}' LIMIT 1`;
		try {
			const result = await app.zcql().executeZCQLQuery(query);
			if (Array.isArray(result) && result.length > 0) {
				return result[0][WORKDRIVE_CONNECTIONS_TABLE] || result[0];
			}
		} catch {}
	}

	// 2. Check in-memory store fallback
	const cached = MEMORY_CONNECTIONS.get(normalizedEmail);
	if (cached) {
		return {
			...cached,
			access_token: encryptToken(cached.accessToken),
			refresh_token: cached.refreshToken ? encryptToken(cached.refreshToken) : ""
		};
	}

	return null;
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

async function upsertConnection(app, { email, displayName, accessToken, refreshToken, expiresIn, scope, apiDomain }) {
	const normalizedEmail = String(email || "").toLowerCase().trim();
	const existing = await getConnectionRow(app, normalizedEmail);

	const effectiveRefreshToken = refreshToken || (existing && existing.refresh_token ? decryptToken(existing.refresh_token) : "");
	const effectiveApiDomain = apiDomain || (existing && existing.api_domain) || getApiDomain(normalizedEmail);

	// Update memory cache immediately
	MEMORY_CONNECTIONS.set(normalizedEmail, {
		email: normalizedEmail,
		displayName: displayName || (existing && existing.display_name) || "",
		accessToken,
		refreshToken: effectiveRefreshToken,
		expiresAt: new Date(Date.now() + Number(expiresIn || 3600) * 1000).toISOString(),
		scope: scope || (existing && existing.scope) || "",
		status: "CONNECTED",
		apiDomain: effectiveApiDomain
	});

	if (!app || typeof app.datastore !== "function") return;

	try {
		const datastore = app.datastore();
		const table = datastore.table(WORKDRIVE_CONNECTIONS_TABLE);

		const payload = {
			email: normalizedEmail,
			display_name: displayName || (existing && existing.display_name) || "",
			access_token: encryptToken(accessToken),
			expires_at: new Date(Date.now() + Number(expiresIn || 3600) * 1000).toISOString(),
			scope: scope || (existing && existing.scope) || "",
			status: "CONNECTED"
		};
		if (effectiveRefreshToken) {
			payload.refresh_token = encryptToken(effectiveRefreshToken);
		}

		if (existing && existing.ROWID) {
			payload.ROWID = existing.ROWID;
			await table.updateRow(payload);
		} else {
			await table.insertRow(payload);
		}
	} catch (dbErr) {
		// Table may not exist in Data Store; stateless session tokens guarantee connectivity
	}
}

async function checkConnectionStatus(app, email, session) {
	const normalizedEmail = String(email || (session && session.email) || "").toLowerCase().trim();
	if (!normalizedEmail) return { connected: false, provider: "Zoho WorkDrive" };

	// 1. Direct check from session credentials
	if (session && (session.accessToken || session.refreshToken)) {
		return {
			connected: true,
			provider: "Zoho WorkDrive",
			user: { email: normalizedEmail, displayName: session.displayName || null }
		};
	}

	// 2. Check memory cache
	const cached = MEMORY_CONNECTIONS.get(normalizedEmail);
	if (cached && cached.status === "CONNECTED") {
		return {
			connected: true,
			provider: "Zoho WorkDrive",
			user: { email: cached.email, displayName: cached.displayName || null }
		};
	}

	// 3. Check Data Store
	const row = await getConnectionRow(app, normalizedEmail);
	if (!row) return { connected: false, provider: "Zoho WorkDrive" };
	return {
		connected: String(row.status || "").toUpperCase() === "CONNECTED",
		provider: "Zoho WorkDrive",
		user: { email: row.email || normalizedEmail, displayName: row.display_name || null }
	};
}

async function getValidAccessToken(app, email, session) {
	const normalizedEmail = String(email || (session && session.email) || "").toLowerCase().trim();

	// 1. Check if token in session is valid and unexpired
	if (session && session.accessToken) {
		const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
		if (!expiresAt || expiresAt - Date.now() > REFRESH_MARGIN_MS) {
			return session.accessToken;
		}
	}

	// 2. Check in-memory store
	const cached = MEMORY_CONNECTIONS.get(normalizedEmail);
	if (cached && cached.accessToken) {
		const expiresAt = cached.expiresAt ? new Date(cached.expiresAt).getTime() : 0;
		if (!expiresAt || expiresAt - Date.now() > REFRESH_MARGIN_MS) {
			return cached.accessToken;
		}
	}

	// 3. Check Data Store row (if table exists)
	const row = await getConnectionRow(app, normalizedEmail);
	if (row && String(row.status || "").toUpperCase() === "CONNECTED") {
		const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
		if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
			return decryptToken(row.access_token);
		}
	}

	// 4. Refresh token
	const refreshTokenValue = (session && session.refreshToken) ||
		(cached && cached.refreshToken) ||
		(row && row.refresh_token ? decryptToken(row.refresh_token) : "");

	if (!refreshTokenValue) {
		if (session && session.accessToken) return session.accessToken;
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive is not connected for this account.");
	}

	let refreshed;
	try {
		const apiDom = (session && session.apiDomain) || (cached && cached.apiDomain) || "";
		let domainToUse;
		if (apiDom.includes(".zoho.in") || normalizedEmail.includes("spikra") || (process.env.ZOHO_ACCOUNTS_DOMAIN && process.env.ZOHO_ACCOUNTS_DOMAIN.includes(".zoho.in"))) {
			domainToUse = "https://accounts.zoho.in";
		} else if (apiDom.includes(".zoho.eu")) {
			domainToUse = "https://accounts.zoho.eu";
		}
		refreshed = await refreshAccessToken(refreshTokenValue, domainToUse);
	} catch {
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	await upsertConnection(app, {
		email: normalizedEmail,
		displayName: (session && session.displayName) || (row && row.display_name) || "",
		accessToken: refreshed.access_token,
		refreshToken: refreshed.refresh_token || refreshTokenValue,
		expiresIn: refreshed.expires_in,
		scope: refreshed.scope || (row && row.scope) || "",
		apiDomain: (session && session.apiDomain) || (cached && cached.apiDomain) || ""
	});

	if (session) {
		session.accessToken = refreshed.access_token;
		session.expiresAt = new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString();
	}

	return refreshed.access_token;
}

function request(method, path, { accessToken, qs = {}, expectBinary = false, email, session } = {}) {
	return new Promise((resolve, reject) => {
		const baseDomain = getApiDomain(email, session);
		const url = new URL(baseDomain.replace(/\/+$/, "") + path);
		for (const [key, value] of Object.entries(qs)) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}

		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method,
				headers: {
					Accept: "application/vnd.api+json",
					Authorization: `Zoho-oauthtoken ${accessToken}`
				},
				timeout: 60000
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const buffer = Buffer.concat(chunks);
					const statusCode = res.statusCode || 500;

					if (statusCode === 401) {
						return reject(new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "WorkDrive rejected the access token."));
					}
					if (statusCode === 404) {
						return reject(new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", `WorkDrive resource not found: ${method} ${path}`, 404));
					}
					if (statusCode === 403) {
						return reject(new WorkdriveError("WORKDRIVE_PERMISSION_DENIED", `WorkDrive denied access: ${method} ${path}`, 403));
					}
					if (statusCode < 200 || statusCode >= 300) {
						return reject(
							new WorkdriveError(
								"WORKDRIVE_API_FAILED",
								`WorkDrive API returned HTTP ${statusCode} for ${method} ${path}: ${buffer.toString("utf8").slice(0, 300)}`
							)
						);
					}
					if (expectBinary) return resolve(buffer);
					try {
						resolve(buffer.length ? JSON.parse(buffer.toString("utf8")) : {});
					} catch (parseErr) {
						reject(new WorkdriveError("WORKDRIVE_API_FAILED", `WorkDrive returned a non-JSON response: ${parseErr.message}`));
					}
				});
			}
		);

		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", `WorkDrive request timed out: ${method} ${path}`)); });
		req.on("error", (err) => reject(new WorkdriveError("WORKDRIVE_API_FAILED", `Failed to reach WorkDrive: ${err.message}`)));
		req.end();
	});
}

async function listFiles(app, email, folderId, session) {
	if (!folderId) throw new WorkdriveError("VALIDATION_FAILED", "folder_id is required.");
	const accessToken = await getValidAccessToken(app, email, session);
	try {
		const response = await request("GET", `/files/${encodeURIComponent(folderId)}/files`, { accessToken, email, session });
		return Array.isArray(response.data) ? response.data : [];
	} catch (err) {
		try {
			const psResponse = await request("GET", `/privatespace/${encodeURIComponent(folderId)}/files`, { accessToken, email, session });
			return Array.isArray(psResponse.data) ? psResponse.data : [];
		} catch {}
		throw err;
	}
}

// Lists root items: Team Folders (workspaces) + Private Space ("My Folders").
async function listRootItems(app, email, session) {
	const accessToken = await getValidAccessToken(app, email, session);
	const items = [];

	let zuid = null;
	try {
		const userRes = await request("GET", "/users/me", { accessToken, email, session });
		zuid = (userRes && userRes.data && (userRes.data.id || (userRes.data.attributes && (userRes.data.attributes.zid || userRes.data.attributes.zuid)))) || null;
	} catch (e) {
		console.warn("[WorkDrive] Could not fetch /users/me:", e.message);
	}

	// 1. Fetch private space via resolvePrivateSpaceId (30-min in-memory cache) with fallback
	let privateSpaceId = null;
	if (session && session.accessToken) {
		try {
			privateSpaceId = await resolvePrivateSpaceId(session);
		} catch (e) {
			console.warn("[WorkDrive] Fast private space resolution failed, trying fallback:", e.message);
		}
	}
	if (!privateSpaceId) {
		try {
			const directRes = await request("GET", "/users/me/privatespace", { accessToken, email, session });
			const psList = Array.isArray(directRes && directRes.data) ? directRes.data : (directRes && directRes.data ? [directRes.data] : []);
			if (psList.length > 0 && psList[0] && psList[0].id) {
				privateSpaceId = psList[0].id;
			}
		} catch (e) {
			console.warn("[WorkDrive] Could not fetch /users/me/privatespace:", e.message);
		}
	}

	// 2. Fetch user teams / workspaces if permitted
	let teamIds = [];
	if (zuid) {
		try {
			const teamsRes = await request("GET", `/users/${encodeURIComponent(zuid)}/teams`, { accessToken, email, session });
			const teamList = Array.isArray(teamsRes && teamsRes.data) ? teamsRes.data : [];
			teamIds = teamList.map((t) => t.id).filter(Boolean);
		} catch {}
	}

	for (const teamId of teamIds) {
		// Workspaces (Team Folders)
		try {
			const wsRes = await request("GET", `/teams/${encodeURIComponent(teamId)}/workspaces`, { accessToken, email, session });
			const wsList = Array.isArray(wsRes && wsRes.data) ? wsRes.data : [];
			for (const ws of wsList) {
				const attrs = ws.attributes || {};
				items.push({
					id: ws.id,
					type: "workspace",
					attributes: {
						name: attrs.name || attrs.display_name || "Team Folder",
						type: "workspace",
						is_folder: true,
						modified_time: attrs.modified_time || attrs.updated_time || null
					}
				});
			}
		} catch {}

		// Private Space fallback per team
		if (!privateSpaceId && zuid) {
			try {
				const psRes = await request("GET", `/users/${encodeURIComponent(teamId + "-" + zuid)}/privatespace`, { accessToken, email, session });
				const psData = psRes && psRes.data;
				const psObj = Array.isArray(psData) ? psData[0] : psData;
				if (psObj && psObj.id) {
					privateSpaceId = psObj.id;
				}
			} catch {}
		}
	}

	// 3. Fetch files inside the user's private space
	if (privateSpaceId) {
		try {
			const childRes = await request("GET", `/files/${encodeURIComponent(privateSpaceId)}/files`, { accessToken, email, session });
			const childList = Array.isArray(childRes && childRes.data) ? childRes.data : [];
			if (childList.length > 0) {
				for (const child of childList) {
					items.push(child);
				}
			} else if (items.length === 0) {
				items.push({
					id: privateSpaceId,
					type: "private_space",
					attributes: {
						name: "My Folders (Private Space)",
						type: "folder",
						is_folder: true
					}
				});
			}
		} catch {
			if (items.length === 0) {
				items.push({
					id: privateSpaceId,
					type: "private_space",
					attributes: {
						name: "My Folders (Private Space)",
						type: "folder",
						is_folder: true
					}
				});
			}
		}
	}

	return items;
}

async function getFileMetadata(app, email, fileId, session) {
	if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.");
	const accessToken = await getValidAccessToken(app, email, session);
	const response = await request("GET", `/files/${encodeURIComponent(fileId)}`, { accessToken, email, session });
	return response.data || null;
}

async function downloadFile(app, email, fileId, session) {
	if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.");
	const accessToken = await getValidAccessToken(app, email, session);
	let buffer;
	let dlError = null;

	try {
		buffer = await request("GET", `/files/${encodeURIComponent(fileId)}/download`, {
			accessToken,
			expectBinary: true,
			email,
			session
		});
	} catch (err) {
		dlError = err;
	}

	if (!buffer || buffer.length === 0) {
		try {
			buffer = await request("GET", `/download/${encodeURIComponent(fileId)}`, {
				accessToken,
				expectBinary: true,
				email,
				session
			});
			dlError = null;
		} catch (fallbackErr) {
			dlError = dlError || fallbackErr;
		}
	}

	if (!buffer || buffer.length === 0) {
		throw dlError || new WorkdriveError("WORKDRIVE_API_FAILED", `Failed to download file ${fileId}`);
	}

	let meta = null;
	try {
		meta = await getFileMetadata(app, email, fileId, session);
	} catch {}

	return {
		buffer,
		fileName: (meta && meta.attributes && meta.attributes.name) || `workdrive-${fileId}.pdf`,
		mimeType: (meta && meta.attributes && meta.attributes.mime_type) || "application/octet-stream",
		size: buffer.length
	};
}

async function disconnectConnection(app, email, session) {
	const normalizedEmail = (email || (session && session.email) || "").toLowerCase().trim();
	MEMORY_CONNECTIONS.delete(normalizedEmail);

	const row = await getConnectionRow(app, normalizedEmail);
	if (row && row.access_token) {
		try {
			await revokeToken(decryptToken(row.access_token));
		} catch {}
	} else if (session && session.accessToken) {
		try {
			await revokeToken(session.accessToken);
		} catch {}
	}

	if (row && row.ROWID && app && typeof app.datastore === "function") {
		await app.datastore().table(WORKDRIVE_CONNECTIONS_TABLE).updateRow({ ROWID: row.ROWID, status: "DISCONNECTED" }).catch(() => {});
	}

	return { disconnected: true, email: normalizedEmail };
}

module.exports = {
	checkConnectionStatus,
	getValidAccessToken,
	listFiles,
	listRootItems,
	getFileMetadata,
	downloadFile,
	disconnectConnection,
	upsertConnection,
	resolvePrivateSpaceId,
	normalizeItem,
	searchWorkDriveItems,
	WORKDRIVE_CONNECTIONS_TABLE
};
