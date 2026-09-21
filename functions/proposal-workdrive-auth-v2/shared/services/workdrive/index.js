"use strict";

// Zoho WorkDrive API client using PER-SALESPERSON tokens from WORKDRIVE_LOGIN, keyed by
// their Zoho email (not a Catalyst identity - there isn't one; Zoho's own OAuth login is
// the identity check). Never the Catalyst Connection - Connections return one shared
// credential set for every caller, which can't represent "Salesperson A's files vs
// Salesperson B's files." Token refresh happens here transparently before every call.
//
// NOT YET VERIFIED AGAINST A REAL WORKDRIVE RESPONSE: endpoint paths follow Zoho
// WorkDrive's documented API v1 shape - confirm once a real login has authorized and a
// real call has been made.

const https = require("https");
const { URL } = require("url");
const { ProposalError } = require("../../utils/errors");
const { decryptToken, encryptToken, refreshAccessToken, revokeToken } = require("../auth");

const DEFAULT_API_DOMAIN = "https://www.zohoapis.com/workdrive/api/v1";
const WORKDRIVE_LOGIN_TABLE = "W2_USER_WORKDRIVE";
const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh 2 minutes before actual expiry

function getApiDomain() {
	return String(process.env.WORKDRIVE_API_DOMAIN || DEFAULT_API_DOMAIN).trim().replace(/\/+$/, "");
}

async function getLoginRow(app, email) {
	if (!app || typeof app.zcql !== "function" || !email) return null;
	const query = `SELECT * FROM ${WORKDRIVE_LOGIN_TABLE} WHERE email = '${escapeQueryValue(email)}' LIMIT 1`;
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		if (Array.isArray(result) && result.length > 0) {
			return result[0][WORKDRIVE_LOGIN_TABLE] || result[0];
		}
	} catch {}
	return null;
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

// Called by proposal-workdrive-auth-v2 right after a successful code exchange + user-info
// lookup, and again here internally after every refresh - single place that writes this
// table. Never receives or stores a password - only the OAuth token pair.
async function upsertLogin(app, { email, displayName, accessToken, refreshToken, expiresIn, scope }) {
	const datastore = app.datastore();
	const table = datastore.table(WORKDRIVE_LOGIN_TABLE);
	const existing = await getLoginRow(app, email);

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
		throw new ProposalError("WORKDRIVE_AUTH_FAILED", "No refresh token returned on initial authorization - cannot store a renewable connection.");
	}
	return table.insertRow(payload);
}

async function checkConnectionStatus(app, email) {
	const row = await getLoginRow(app, email);
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
	const row = await getLoginRow(app, email);
	if (!row || String(row.status || "").toUpperCase() !== "CONNECTED") {
		throw new ProposalError("WORKDRIVE_AUTH_FAILED", "WorkDrive is not connected for this account.");
	}

	const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
	if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
		return decryptToken(row.access_token);
	}

	const refreshToken = decryptToken(row.refresh_token);
	if (!refreshToken) {
		throw new ProposalError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	let refreshed;
	try {
		refreshed = await refreshAccessToken(refreshToken);
	} catch (err) {
		await app.datastore().table(WORKDRIVE_LOGIN_TABLE).updateRow({ ROWID: row.ROWID, status: "ERROR" }).catch(() => {});
		throw new ProposalError("WORKDRIVE_TOKEN_EXPIRED", "The WorkDrive connection has expired and needs to be reconnected.");
	}

	await upsertLogin(app, {
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
						return reject(new ProposalError("WORKDRIVE_TOKEN_EXPIRED", "WorkDrive rejected the access token."));
					}
					if (statusCode < 200 || statusCode >= 300) {
						return reject(
							new ProposalError(
								"WORKDRIVE_API_FAILED",
								`WorkDrive API returned HTTP ${statusCode} for ${method} ${path}: ${buffer.toString("utf8").slice(0, 300)}`
							)
						);
					}
					if (expectBinary) return resolve(buffer);
					try {
						resolve(buffer.length ? JSON.parse(buffer.toString("utf8")) : {});
					} catch (parseErr) {
						reject(new ProposalError("WORKDRIVE_API_FAILED", `WorkDrive returned a non-JSON response: ${parseErr.message}`));
					}
				});
			}
		);

		req.on("timeout", () => { req.destroy(); reject(new ProposalError("TIMEOUT", `WorkDrive request timed out: ${method} ${path}`)); });
		req.on("error", (err) => reject(new ProposalError("WORKDRIVE_API_FAILED", `Failed to reach WorkDrive: ${err.message}`)));
		req.end();
	});
}

// VERIFY: real WorkDrive endpoint for listing a folder's children.
async function listFiles(app, email, folderId) {
	const accessToken = await getValidAccessToken(app, email);
	const response = await request("GET", `/files/${encodeURIComponent(folderId)}/files`, { accessToken });
	return Array.isArray(response.data) ? response.data : [];
}

// VERIFY: real WorkDrive endpoint for the caller's own root-level items (private space +
// team folders landing view) - used when the frontend opens WorkDrive with no folder
// selected yet, before the salesperson drills into a specific folder.
async function listRootItems(app, email) {
	const accessToken = await getValidAccessToken(app, email);
	const response = await request("GET", "/users/me/files", { accessToken });
	return Array.isArray(response.data) ? response.data : [];
}

// VERIFY: real WorkDrive endpoint for a single resource's metadata.
async function getFileMetadata(app, email, fileId) {
	const accessToken = await getValidAccessToken(app, email);
	const response = await request("GET", `/files/${encodeURIComponent(fileId)}`, { accessToken });
	return response.data || null;
}

// VERIFY: real WorkDrive endpoint for downloading file content.
async function downloadFile(app, email, fileId) {
	const accessToken = await getValidAccessToken(app, email);
	return request("GET", `/download/${encodeURIComponent(fileId)}`, { accessToken, expectBinary: true });
}

// Best-effort revoke at Zoho's end (so the grant actually stops working, not just our own
// record of it), then always marks the row disconnected locally regardless of whether the
// revoke call itself succeeded - the row is kept (not deleted) as a reconnect/audit trail.
async function disconnectLogin(app, email) {
	const row = await getLoginRow(app, email);
	if (!row) return { connected: false, provider: "Zoho WorkDrive" };

	try {
		const accessToken = decryptToken(row.access_token);
		if (accessToken) await revokeToken(accessToken);
	} catch {}

	await app.datastore().table(WORKDRIVE_LOGIN_TABLE).updateRow({ ROWID: row.ROWID, status: "DISCONNECTED" }).catch(() => {});
	return { connected: false, provider: "Zoho WorkDrive" };
}

module.exports = {
	checkConnectionStatus,
	upsertLogin,
	disconnectLogin,
	getValidAccessToken,
	listFiles,
	listRootItems,
	getFileMetadata,
	downloadFile,
	WORKDRIVE_LOGIN_TABLE
};
