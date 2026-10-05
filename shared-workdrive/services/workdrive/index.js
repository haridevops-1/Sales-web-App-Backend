"use strict";

// Zoho WorkDrive API client using PER-SALESPERSON tokens from WORKDRIVE_CONNECTIONS,
// keyed by their Zoho email (not a Catalyst identity - there isn't one; Zoho's own OAuth
// login is the identity check). Never the Catalyst Connection - Connections return one
// shared credential set for every caller, which can't represent "Salesperson A's files
// vs Salesperson B's files." Token refresh happens here transparently before every call.
// Shared by both Workspace 1 and Workspace 2.
//
// NOT YET VERIFIED AGAINST A REAL WORKDRIVE RESPONSE: endpoint paths follow Zoho
// WorkDrive's documented API v1 shape - confirm once a real login has authorized and a
// real call has been made.

const https = require("https");
const { URL } = require("url");
const { WorkdriveError } = require("../../utils/errors");
const { decryptToken, encryptToken, refreshAccessToken, revokeToken } = require("../auth");

const DEFAULT_API_DOMAIN = "https://www.zohoapis.com/workdrive/api/v1";
const WORKDRIVE_CONNECTIONS_TABLE = "WORKDRIVE_CONNECTIONS";
const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh 2 minutes before actual expiry

// In-memory fallback map: email -> connection object
const MEMORY_CONNECTIONS = new Map();

function getApiDomain(email) {
	const cached = email ? MEMORY_CONNECTIONS.get(email.toLowerCase()) : null;
	if (cached && cached.apiDomain) return cached.apiDomain;

	const accountsDomain = String(process.env.ZOHO_ACCOUNTS_DOMAIN || "").toLowerCase();
	if (accountsDomain.includes(".zoho.in")) return "https://www.zohoapis.in/workdrive/api/v1";
	if (accountsDomain.includes(".zoho.eu")) return "https://www.zohoapis.eu/workdrive/api/v1";
	if (accountsDomain.includes(".zoho.com.au")) return "https://www.zohoapis.com.au/workdrive/api/v1";
	return String(process.env.WORKDRIVE_API_DOMAIN || DEFAULT_API_DOMAIN).trim().replace(/\/+$/, "");
}

async function getConnectionRow(app, email) {
	if (!email) return null;
	const normalizedEmail = email.toLowerCase().trim();

	// 1. Try querying Catalyst Data Store via ZCQL
	if (app && typeof app.zcql === "function") {
		const query = `SELECT * FROM ${WORKDRIVE_CONNECTIONS_TABLE} WHERE email = '${escapeQueryValue(normalizedEmail)}' LIMIT 1`;
		try {
			const result = await app.zcql().executeZCQLQuery(query);
			if (Array.isArray(result) && result.length > 0) {
				return result[0][WORKDRIVE_CONNECTIONS_TABLE] || result[0];
			}
		} catch (err) {
			console.warn("[WorkDrive] ZCQL query for connection returned:", err.message);
		}
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

// Single place that writes this table and caches the active session in memory.
async function upsertConnection(app, { email, displayName, accessToken, refreshToken, expiresIn, scope, apiDomain }) {
	const normalizedEmail = String(email || "").toLowerCase().trim();
	const existing = await getConnectionRow(app, normalizedEmail);

	const effectiveRefreshToken = refreshToken || (existing && existing.refresh_token ? decryptToken(existing.refresh_token) : "");
	const effectiveApiDomain = apiDomain || (existing && existing.api_domain) || getApiDomain(normalizedEmail);

	// Update memory cache immediately so connection works even if Data Store table is missing
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

	try {
		if (existing && existing.ROWID) {
			payload.ROWID = existing.ROWID;
			await table.updateRow(payload);
		} else {
			await table.insertRow(payload);
		}
	} catch (dbErr) {
		console.warn("[WorkDrive] Could not persist connection in Data Store table (in-memory connection active):", dbErr.message);
	}
}

async function checkConnectionStatus(app, email) {
	if (!email) return { connected: false, provider: "Zoho WorkDrive" };
	const normalizedEmail = email.toLowerCase().trim();
	const cached = MEMORY_CONNECTIONS.get(normalizedEmail);
	if (cached && cached.status === "CONNECTED") {
		return {
			connected: true,
			provider: "Zoho WorkDrive",
			user: { email: cached.email, displayName: cached.displayName || null }
		};
	}
	const row = await getConnectionRow(app, normalizedEmail);
	if (!row) return { connected: false, provider: "Zoho WorkDrive" };
	return {
		connected: String(row.status || "").toUpperCase() === "CONNECTED",
		provider: "Zoho WorkDrive",
		user: { email: row.email || normalizedEmail, displayName: row.display_name || null }
	};
}

// Returns a valid, decrypted access token for this salesperson - refreshing and
// persisting a new one first if the stored one is expired or about to expire.
async function getValidAccessToken(app, email) {
	const normalizedEmail = (email || "").toLowerCase().trim();
	const cached = MEMORY_CONNECTIONS.get(normalizedEmail);
	if (cached && cached.accessToken) {
		const expiresAt = cached.expiresAt ? new Date(cached.expiresAt).getTime() : 0;
		if (!expiresAt || expiresAt - Date.now() > REFRESH_MARGIN_MS) {
			return cached.accessToken;
		}
	}

	const row = await getConnectionRow(app, normalizedEmail);
	if (!row || String(row.status || "").toUpperCase() !== "CONNECTED") {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive is not connected for this account.");
	}

	const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
	if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
		return decryptToken(row.access_token);
	}

	const refreshTokenValue = row.refresh_token ? decryptToken(row.refresh_token) : "";
	if (!refreshTokenValue) {
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	let refreshed;
	try {
		const accountsDomain = String(process.env.ZOHO_ACCOUNTS_DOMAIN || "").toLowerCase();
		const domainToUse = accountsDomain.includes(".zoho.in") ? "https://accounts.zoho.in" : undefined;
		refreshed = await refreshAccessToken(refreshTokenValue, domainToUse);
	} catch {
		if (app && typeof app.datastore === "function" && row.ROWID) {
			await app.datastore().table(WORKDRIVE_CONNECTIONS_TABLE).updateRow({ ROWID: row.ROWID, status: "ERROR" }).catch(() => {});
		}
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	await upsertConnection(app, {
		email: normalizedEmail,
		displayName: row.display_name,
		accessToken: refreshed.access_token,
		refreshToken: refreshed.refresh_token || refreshTokenValue,
		expiresIn: refreshed.expires_in,
		scope: refreshed.scope || row.scope
	});

	return refreshed.access_token;
}

function request(method, path, { accessToken, qs = {}, expectBinary = false, email } = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(getApiDomain(email) + path);
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

// VERIFY: real WorkDrive endpoint for listing a folder's children.
async function listFiles(app, email, folderId) {
	if (!folderId) throw new WorkdriveError("VALIDATION_FAILED", "folder_id is required.");
	const accessToken = await getValidAccessToken(app, email);
	try {
		const response = await request("GET", `/files/${encodeURIComponent(folderId)}/files`, { accessToken, email });
		return Array.isArray(response.data) ? response.data : [];
	} catch (err) {
		try {
			const psResponse = await request("GET", `/privatespace/${encodeURIComponent(folderId)}/files`, { accessToken, email });
			return Array.isArray(psResponse.data) ? psResponse.data : [];
		} catch {}
		throw err;
	}
}

// Lists root items: Team Folders (workspaces) + Private Space ("My Folders").
async function listRootItems(app, email) {
	const accessToken = await getValidAccessToken(app, email);
	const items = [];

	let zuid = null;
	try {
		const userRes = await request("GET", "/users/me", { accessToken, email });
		zuid = (userRes && userRes.data && (userRes.data.id || (userRes.data.attributes && userRes.data.attributes.zid))) || null;
	} catch (e) {
		console.warn("[WorkDrive] Could not fetch /users/me:", e.message);
	}

	let teamIds = [];
	if (zuid) {
		try {
			const teamsRes = await request("GET", `/users/${encodeURIComponent(zuid)}/teams`, { accessToken, email });
			const teamList = Array.isArray(teamsRes && teamsRes.data) ? teamsRes.data : [];
			teamIds = teamList.map((t) => t.id).filter(Boolean);
		} catch (e) {
			console.warn("[WorkDrive] Could not fetch user teams:", e.message);
		}
	}

	for (const teamId of teamIds) {
		// Workspaces (Team Folders)
		try {
			const wsRes = await request("GET", `/teams/${encodeURIComponent(teamId)}/workspaces`, { accessToken, email });
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
		} catch (e) {
			console.warn(`[WorkDrive] Could not fetch workspaces for team ${teamId}:`, e.message);
		}

		// Private Space
		if (zuid) {
			try {
				const psRes = await request("GET", `/users/${encodeURIComponent(teamId + "-" + zuid)}/privatespace`, { accessToken, email });
				const psData = psRes && psRes.data;
				if (psData && psData.id) {
					items.push({
						id: psData.id,
						type: "private_space",
						attributes: {
							name: (psData.attributes && psData.attributes.name) || "My Folders (Private Space)",
							type: "folder",
							is_folder: true
						}
					});
				}
			} catch {}
		}
	}

	// Fallback to /users/me/privatespace if no items found
	if (items.length === 0) {
		try {
			const directRes = await request("GET", "/users/me/privatespace", { accessToken, email });
			if (directRes && directRes.data && directRes.data.id) {
				items.push({
					id: directRes.data.id,
					type: "private_space",
					attributes: {
						name: (directRes.data.attributes && directRes.data.attributes.name) || "My Folders",
						type: "folder",
						is_folder: true
					}
				});
			}
		} catch {}
	}

	return items;
}

// VERIFY: real WorkDrive endpoint for a single resource's metadata.
async function getFileMetadata(app, email, fileId) {
	if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.");
	const accessToken = await getValidAccessToken(app, email);
	const response = await request("GET", `/files/${encodeURIComponent(fileId)}`, { accessToken, email });
	return response.data || null;
}

// VERIFY: real WorkDrive endpoint for downloading file content. Returns { buffer,
// fileName, mimeType } - callers (Workspace 1/2 upload flows) need the name/type to
// treat this the same as a locally-uploaded file.
async function downloadFile(app, email, fileId) {
	if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.");
	const accessToken = await getValidAccessToken(app, email);
	let buffer;
	let metadata = null;
	try {
		metadata = await getFileMetadata(app, email, fileId);
	} catch (e) {
		console.warn("[WorkDrive] Could not fetch file metadata for download:", e.message);
	}

	try {
		buffer = await request("GET", `/files/${encodeURIComponent(fileId)}/download`, { accessToken, expectBinary: true, email });
	} catch (err) {
		buffer = await request("GET", `/download/${encodeURIComponent(fileId)}`, { accessToken, expectBinary: true, email });
	}

	const attrs = (metadata && metadata.attributes) || {};
	return {
		buffer,
		fileName: attrs.name || `workdrive-file-${fileId}`,
		mimeType: attrs.mime_type || attrs.type || "application/octet-stream"
	};
}

async function disconnectConnection(app, email) {
	const row = await getConnectionRow(app, email);
	if (!row) return { connected: false, provider: "Zoho WorkDrive" };

	try {
		const accessToken = decryptToken(row.access_token);
		if (accessToken) await revokeToken(accessToken);
	} catch {}

	await app.datastore().table(WORKDRIVE_CONNECTIONS_TABLE).updateRow({ ROWID: row.ROWID, status: "DISCONNECTED" }).catch(() => {});
	return { connected: false, provider: "Zoho WorkDrive" };
}

module.exports = {
	checkConnectionStatus,
	upsertConnection,
	disconnectConnection,
	getValidAccessToken,
	listFiles,
	listRootItems,
	getFileMetadata,
	downloadFile,
	WORKDRIVE_CONNECTIONS_TABLE
};
