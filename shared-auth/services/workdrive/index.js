"use strict";

// Zoho WorkDrive client acting for one signed-in app user. The connection is the user's
// WORKDRIVE_CONNECTIONS row (id carried by their session). It stores the encrypted refresh
// token, so access tokens are renewed silently and the user is never asked to approve again
// until they disconnect. A missing or unreadable connection is an error, never a default.

const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { WorkdriveError } = require("../../utils/errors");
const { ZOHO_REGIONS, resolveRegion } = require("../../utils/config");
const { decryptToken, encryptToken, refreshAccessToken, revokeToken } = require("../auth");
const { CONNECTIONS_TABLE } = require("../users");

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FOLDERS_TO_SCAN = 25;
const PRIVATE_SPACE_TTL_MS = 30 * 60 * 1000;

const privateSpaceCache = new Map();

const notConnected = (message) => new WorkdriveError("WORKDRIVE_NOT_CONNECTED", message || "Connect Zoho WorkDrive to continue.", 403);

// ---- item shaping -----------------------------------------------------------------

function normalizeItem(raw) {
	if (!raw) return null;
	const attrs = raw.attributes || {};
	const isFolder = raw.type === "files"
		? (attrs.type === "folder" || attrs.is_folder === true)
		: ["folder", "workspace", "private_space", "teamfolders"].includes(raw.type);
	const ext = attrs.extn ? `.${String(attrs.extn).replace(/^\./, "")}` : "";

	return {
		id: raw.id,
		name: attrs.name || attrs.display_name || "Untitled",
		type: isFolder ? "folder" : "file",
		isFolder,
		size: Number((attrs.storage_info && attrs.storage_info.size_in_bytes) || attrs.size || 0),
		extension: ext,
		modifiedTime: attrs.modified_time_in_millisecond
			? new Date(Number(attrs.modified_time_in_millisecond)).toISOString()
			: (attrs.modified_time || null),
		permalink: attrs.permalink || null
	};
}

// ---- connection row ---------------------------------------------------------------

async function readConnectionRow(app, user) {
	if (!user || !user.wdRowId) throw notConnected();
	let row;
	try {
		row = await app.datastore().table(CONNECTIONS_TABLE).getRow(String(user.wdRowId));
	} catch (err) {
		console.error("[WorkDrive] Connection row read failed:", err && err.message);
		throw new WorkdriveError("WORKDRIVE_API_FAILED", "WorkDrive connection store is unavailable.", 503);
	}
	if (!row || String(row.user_email || "").toLowerCase() !== String(user.email).toLowerCase()) throw notConnected();
	return row;
}

async function updateConnectionRow(app, rowId, fields) {
	try {
		await app.datastore().table(CONNECTIONS_TABLE).updateRow({ ...fields, ROWID: String(rowId) });
	} catch (err) {
		console.error("[WorkDrive] Saving connection failed:", err && err.message);
		throw new WorkdriveError("WORKDRIVE_API_FAILED", "Could not save the WorkDrive connection.", 503);
	}
}

// Called after the user approved WorkDrive access (POST /workdrive/connect).
async function saveConnection(app, user, { wdEmail, displayName, accessToken, refreshToken, expiresIn, scope, regionKey }) {
	await updateConnectionRow(app, user.wdRowId, {
		wd_email: wdEmail,
		display_name: displayName || "",
		access_token: encryptToken(accessToken),
		refresh_token: encryptToken(refreshToken),
		expires_at: new Date(Date.now() + Number(expiresIn || 3600) * 1000).toISOString(),
		scope: scope || "",
		region: regionKey,
		status: "CONNECTED"
	});
}

async function getConnectionStatus(app, user) {
	const row = await readConnectionRow(app, user);
	const connected = String(row.status || "").toUpperCase() === "CONNECTED";
	return { connected, provider: "Zoho WorkDrive", account: connected ? { email: row.wd_email || null, displayName: row.display_name || null } : null };
}

// Returns { accessToken, regionKey } for the user, refreshing and persisting when needed.
async function getContext(app, user) {
	const row = await readConnectionRow(app, user);
	if (String(row.status || "").toUpperCase() !== "CONNECTED") throw notConnected();
	const region = resolveRegion(row.region);

	const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
	if (row.access_token && expires - Date.now() > REFRESH_MARGIN_MS) {
		return { accessToken: decryptToken(row.access_token), regionKey: region.key };
	}

	const refreshToken = decryptToken(row.refresh_token);
	if (!refreshToken) throw notConnected("The WorkDrive connection has expired. Please reconnect.");

	let refreshed;
	try {
		refreshed = await refreshAccessToken(refreshToken, region);
	} catch {
		await updateConnectionRow(app, user.wdRowId, { status: "EXPIRED" });
		throw new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired. Please reconnect.", 403);
	}
	await updateConnectionRow(app, user.wdRowId, {
		access_token: encryptToken(refreshed.access_token),
		expires_at: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString(),
		...(refreshed.refresh_token ? { refresh_token: encryptToken(refreshed.refresh_token) } : {})
	});
	return { accessToken: refreshed.access_token, regionKey: region.key };
}

// ---- WorkDrive HTTP ---------------------------------------------------------------

function request(ctx, path, { expectBinary = false, maxBytes = Infinity } = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(ZOHO_REGIONS[ctx.regionKey].api + path);
		const req = https.request(
			{
				hostname: url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: { Accept: "application/vnd.api+json", Authorization: `Zoho-oauthtoken ${ctx.accessToken}` },
				timeout: 60000
			},
			(res) => {
				const chunks = [];
				let received = 0;
				res.on("data", (chunk) => {
					received += chunk.length;
					if (received > maxBytes) {
						req.destroy();
						return reject(new WorkdriveError("VALIDATION_FAILED", "The file is too large to import.", 413));
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					const buffer = Buffer.concat(chunks);
					const status = res.statusCode || 500;
					if (status === 401) return reject(new WorkdriveError("WORKDRIVE_TOKEN_EXPIRED", "WorkDrive rejected the access token. Please reconnect.", 403));
					if (status === 404) return reject(new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "WorkDrive resource not found.", 404));
					if (status === 403) return reject(new WorkdriveError("WORKDRIVE_PERMISSION_DENIED", "WorkDrive denied access to this resource.", 403));
					if (status < 200 || status >= 300) {
						console.error(`[WorkDrive] HTTP ${status} for ${path}: ${buffer.toString("utf8").slice(0, 300)}`);
						return reject(new WorkdriveError("WORKDRIVE_API_FAILED", `WorkDrive API returned HTTP ${status}.`, 502));
					}
					if (expectBinary) return resolve(buffer);
					try {
						resolve(buffer.length ? JSON.parse(buffer.toString("utf8")) : {});
					} catch {
						reject(new WorkdriveError("WORKDRIVE_API_FAILED", "WorkDrive returned a non-JSON response.", 502));
					}
				});
			}
		);
		req.on("timeout", () => { req.destroy(); reject(new WorkdriveError("TIMEOUT", "WorkDrive request timed out.", 504)); });
		req.on("error", () => reject(new WorkdriveError("WORKDRIVE_API_FAILED", "Failed to reach WorkDrive.", 502)));
		req.end();
	});
}

const asList = (response) => {
	const data = response && response.data;
	return Array.isArray(data) ? data : (data ? [data] : []);
};

// ---- browsing ---------------------------------------------------------------------

async function listFiles(app, user, folderId) {
	if (!folderId) throw new WorkdriveError("VALIDATION_FAILED", "folder_id is required.", 400);
	const ctx = await getContext(app, user);
	return asList(await request(ctx, `/files/${encodeURIComponent(folderId)}/files`));
}

async function resolvePrivateSpaceId(user, ctx) {
	const key = crypto.createHash("sha256").update(user.email).digest("hex");
	const cached = privateSpaceCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.spaceId;

	const spaceId = (asList(await request(ctx, "/users/me/privatespace"))[0] || {}).id;
	if (!spaceId) throw new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "No Private Space found for this account.", 404);
	privateSpaceCache.set(key, { spaceId, expiresAt: Date.now() + PRIVATE_SPACE_TTL_MS });
	return spaceId;
}

// Root = Team Folders the user belongs to + the contents of their Private Space.
async function listRootItems(app, user) {
	const ctx = await getContext(app, user);
	const items = [];

	const me = await request(ctx, "/users/me");
	const attrs = (me && me.data && me.data.attributes) || {};
	const zuid = attrs.zid || attrs.zuid || (me && me.data && me.data.id);
	if (!zuid) throw new WorkdriveError("WORKDRIVE_API_FAILED", "Could not determine the WorkDrive user.", 502);

	for (const team of asList(await request(ctx, `/users/${encodeURIComponent(zuid)}/teams`))) {
		for (const tf of asList(await request(ctx, `/teams/${encodeURIComponent(team.id)}/teamfolders`))) {
			const a = tf.attributes || {};
			items.push({
				id: tf.id,
				type: "teamfolders",
				attributes: { name: a.name || a.display_name || "Team Folder", type: "folder", is_folder: true, modified_time: a.modified_time || a.last_accessed_time || null }
			});
		}
	}

	const privateSpaceId = await resolvePrivateSpaceId(user, ctx);
	return items.concat(asList(await request(ctx, `/files/${encodeURIComponent(privateSpaceId)}/files`)));
}

function nameMatchesQuery(name, cleanQuery) {
	const n = String(name || "").trim().toLowerCase();
	return n.length > 0 && (n.includes(cleanQuery) || cleanQuery.includes(n));
}

// Finds the client folder matching a business name: root folders first, then one level
// down inside each (bounded, sequential, stops on first match).
async function findBusinessFolder(app, user, query) {
	const cleanQuery = String(query || "").trim().toLowerCase();
	if (!cleanQuery) return null;

	const rootFolders = (await listRootItems(app, user)).map(normalizeItem).filter((i) => i && i.isFolder);
	const direct = rootFolders.find((f) => nameMatchesQuery(f.name, cleanQuery));
	if (direct) return { folder: direct, breadcrumb: [direct] };

	for (const folder of rootFolders.slice(0, MAX_FOLDERS_TO_SCAN)) {
		let children;
		try {
			children = await listFiles(app, user, folder.id);
		} catch (err) {
			if (err.code === "WORKDRIVE_PERMISSION_DENIED" || err.code === "WORKDRIVE_FILE_NOT_FOUND") continue;
			throw err;
		}
		const match = children.map(normalizeItem).find((c) => c && c.isFolder && nameMatchesQuery(c.name, cleanQuery));
		if (match) return { folder: match, breadcrumb: [folder, match] };
	}
	return null;
}

// ---- files ------------------------------------------------------------------------

async function getFileMetadata(app, user, fileId) {
	if (!fileId) throw new WorkdriveError("VALIDATION_FAILED", "file_id is required.", 400);
	const ctx = await getContext(app, user);
	const response = await request(ctx, `/files/${encodeURIComponent(fileId)}`);
	return response.data || null;
}

async function downloadFile(app, user, fileId) {
	const meta = await getFileMetadata(app, user, fileId);
	if (!meta || !meta.attributes || !meta.attributes.name) {
		throw new WorkdriveError("WORKDRIVE_FILE_NOT_FOUND", "This WorkDrive file could not be found.", 404);
	}
	const item = normalizeItem(meta);
	if (item.isFolder) throw new WorkdriveError("VALIDATION_FAILED", "A folder cannot be imported as a document.", 400);
	if (item.size > MAX_DOWNLOAD_BYTES) throw new WorkdriveError("VALIDATION_FAILED", "The file is too large to import.", 413);

	const ctx = await getContext(app, user);
	const buffer = await request(ctx, `/download/${encodeURIComponent(fileId)}`, { expectBinary: true, maxBytes: MAX_DOWNLOAD_BYTES });
	if (!buffer.length) throw new WorkdriveError("FILE_DOWNLOAD_FAILED", "WorkDrive returned an empty file.", 502);

	return { buffer, fileName: meta.attributes.name, mimeType: meta.attributes.mime_type || "application/octet-stream", size: buffer.length };
}

// Ends the connection: tokens are wiped locally first, then the grant is revoked at Zoho.
async function disconnectConnection(app, user) {
	const row = await readConnectionRow(app, user);
	const refreshToken = row.refresh_token ? decryptToken(row.refresh_token) : null;
	const region = row.region ? resolveRegion(row.region) : null;

	await updateConnectionRow(app, user.wdRowId, { status: "DISCONNECTED", access_token: "", refresh_token: "", expires_at: "" });
	privateSpaceCache.delete(crypto.createHash("sha256").update(user.email).digest("hex"));

	if (refreshToken && region) {
		try {
			await revokeToken(refreshToken, region);
		} catch (err) {
			console.warn("[WorkDrive] Token revoke at Zoho failed:", err && err.message);
		}
	}
	return { disconnected: true, connected: false };
}

module.exports = {
	getConnectionStatus,
	saveConnection,
	listFiles,
	listRootItems,
	findBusinessFolder,
	getFileMetadata,
	downloadFile,
	disconnectConnection,
	normalizeItem
};
