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

function getApiDomain() {
	return String(process.env.WORKDRIVE_API_DOMAIN || DEFAULT_API_DOMAIN).trim().replace(/\/+$/, "");
}

async function getConnectionRow(app, email) {
	if (!app || typeof app.zcql !== "function" || !email) return null;
	const query = `SELECT * FROM ${WORKDRIVE_CONNECTIONS_TABLE} WHERE email = '${escapeQueryValue(email)}' LIMIT 1`;
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		if (Array.isArray(result) && result.length > 0) {
			return result[0][WORKDRIVE_CONNECTIONS_TABLE] || result[0];
		}
	} catch {}
	return null;
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

// Called by workdrive-auth right after a successful code exchange + user-info lookup,
// and again here internally after every refresh - single place that writes this table.
// Never receives or stores a password - only the OAuth token pair.
async function upsertConnection(app, { email, displayName, accessToken, refreshToken, expiresIn, scope }) {
	const datastore = app.datastore();
	const table = datastore.table(WORKDRIVE_CONNECTIONS_TABLE);
	const existing = await getConnectionRow(app, email);

	const payload = {
		email,
		display_name: displayName || (existing && existing.display_name) || "",
		access_token: encryptToken(accessToken),
		expires_at: new Date(Date.now() + Number(expiresIn || 3600) * 1000).toISOString(),
		scope: scope || (existing && existing.scope) || "",
		status: "CONNECTED"
	};
	// refresh_token is only returned on the initial exchange - keep the existing one on refresh.
	if (refreshToken) {
		payload.refresh_token = encryptToken(refreshToken);
	}

	if (existing) {
		payload.ROWID = existing.ROWID;
		return table.updateRow(payload);
	}
	if (!refreshToken) {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "No refresh token returned on initial authorization - cannot store a renewable connection.");
	}
	return table.insertRow(payload);
}

async function checkConnectionStatus(app, email) {
	const row = await getConnectionRow(app, email);
	if (!row) return { connected: false, provider: "Zoho WorkDrive" };
	return {
		connected: String(row.status || "").toUpperCase() === "CONNECTED",
		provider: "Zoho WorkDrive",
		user: { email: row.email || email || null }
	};
}

// Returns a valid, decrypted access token for this salesperson - refreshing and
// persisting a new one first if the stored one is expired or about to expire.
async function getValidAccessToken(app, email) {
	const row = await getConnectionRow(app, email);
	if (!row || String(row.status || "").toUpperCase() !== "CONNECTED") {
		throw new WorkdriveError("WORKDRIVE_AUTH_FAILED", "WorkDrive is not connected for this account.");
	}

	const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
	if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
		return decryptToken(row.access_token);
	}

	const refreshTokenValue = decryptToken(row.refresh_token);
	if (!refreshTokenValue) {
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	let refreshed;
	try {
		refreshed = await refreshAccessToken(refreshTokenValue);
	} catch {
		await app.datastore().table(WORKDRIVE_CONNECTIONS_TABLE).updateRow({ ROWID: row.ROWID, status: "ERROR" }).catch(() => {});
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	await upsertConnection(app, {
		email,
		accessToken: refreshed.access_token,
		expiresIn: refreshed.expires_in
	});

	return refreshed.access_token;
}

function request(method, path, { accessToken, qs = {}, expectBinary = false } = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(getApiDomain() + path);
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
