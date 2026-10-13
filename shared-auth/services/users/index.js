"use strict";

// App users and server-side sessions (Data Store tables APP_USERS, APP_SESSIONS) plus the
// per-user WORKDRIVE_CONNECTIONS row. A session token is "<APP_SESSIONS rowId>.<secret>":
// only sha256(secret) is stored, so a database read never reveals a usable token, and a
// session can be revoked instantly. Rows are read by id (consistent) rather than by ZCQL.

const crypto = require("crypto");
const { WorkdriveError } = require("../../utils/errors");
const { sha256Hex, safeEqual } = require("../auth");

const USERS_TABLE = "APP_USERS";
const SESSIONS_TABLE = "APP_SESSIONS";
const CONNECTIONS_TABLE = "WORKDRIVE_CONNECTIONS";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^(\d{6,24})\.([A-Za-z0-9_-]{43})$/;

const escapeQueryValue = (value) => String(value || "").replace(/'/g, "''");

function storeError(err, what) {
	console.error(`[auth] ${what} failed:`, err && err.message);
	return new WorkdriveError("WORKDRIVE_API_FAILED", "The account store is unavailable. Please try again.", 503);
}

async function findUserByEmail(app, email) {
	let result;
	try {
		result = await app.zcql().executeZCQLQuery(`SELECT * FROM ${USERS_TABLE} WHERE email = '${escapeQueryValue(email)}' LIMIT 1`);
	} catch (err) {
		throw storeError(err, "user lookup");
	}
	if (!Array.isArray(result) || !result.length) return null;
	return result[0][USERS_TABLE] || result[0];
}

// Signs a user in: creates the user (and their empty WorkDrive connection row) on first
// login, enforces ACTIVE status, then opens a new session. Returns { token, user }.
async function loginUser(app, { email, displayName, zuid }) {
	const datastore = app.datastore();
	const now = new Date().toISOString();
	let user = await findUserByEmail(app, email);

	try {
		if (!user) {
			const connection = await datastore.table(CONNECTIONS_TABLE).insertRow({ user_email: email, status: "NOT_CONNECTED" });
			user = await datastore.table(USERS_TABLE).insertRow({
				email, display_name: displayName || "", zuid: zuid || "", status: "ACTIVE", last_login_at: now,
				wd_row_id: String(connection.ROWID)
			});
		} else {
			if (String(user.status || "").toUpperCase() !== "ACTIVE") {
				throw new WorkdriveError("FORBIDDEN", "This account has been disabled.", 403);
			}
			await datastore.table(USERS_TABLE).updateRow({
				ROWID: String(user.ROWID), display_name: displayName || user.display_name || "", last_login_at: now
			});
		}

		const secret = crypto.randomBytes(32).toString("base64url");
		const session = await datastore.table(SESSIONS_TABLE).insertRow({
			user_row_id: String(user.ROWID),
			email,
			display_name: displayName || user.display_name || "",
			wd_row_id: String(user.wd_row_id),
			token_hash: sha256Hex(secret),
			expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
			status: "ACTIVE"
		});
		await purgeStaleSessions(app, user.ROWID, now);
		return { token: `${session.ROWID}.${secret}`, displayName: displayName || user.display_name || null };
	} catch (err) {
		if (err instanceof WorkdriveError) throw err;
		throw storeError(err, "login");
	}
}

// Housekeeping only: drops this user's expired and revoked sessions so the table stays small.
// A failure here never blocks sign-in and has no effect on which sessions are valid.
async function purgeStaleSessions(app, userRowId, nowIso) {
	try {
		await app.zcql().executeZCQLQuery(
			`DELETE FROM ${SESSIONS_TABLE} WHERE user_row_id = '${escapeQueryValue(userRowId)}' AND (expires_at < '${escapeQueryValue(nowIso)}' OR status = 'REVOKED')`
		);
	} catch (err) {
		console.warn("[auth] Session clean-up skipped:", err && err.message);
	}
}

async function getRowOrNull(table, id) {
	try {
		return (await table.getRow(String(id))) || null;
	} catch {
		return null;
	}
}

// Resolves a bearer token to the signed-in user, or throws a 401.
async function authenticate(app, token) {
	const match = TOKEN_PATTERN.exec(String(token || "").trim());
	if (!match) throw new WorkdriveError("UNAUTHENTICATED", "Sign in to continue.", 401);

	const datastore = app.datastore();
	const session = await getRowOrNull(datastore.table(SESSIONS_TABLE), match[1]);
	if (!session || String(session.status) !== "ACTIVE" || !safeEqual(session.token_hash || "", sha256Hex(match[2]))) {
		throw new WorkdriveError("UNAUTHENTICATED", "Your session is no longer valid. Please sign in again.", 401);
	}
	if (!(new Date(session.expires_at).getTime() > Date.now())) {
		throw new WorkdriveError("SESSION_EXPIRED", "Your session has expired. Please sign in again.", 401);
	}
	const user = await getRowOrNull(datastore.table(USERS_TABLE), session.user_row_id);
	if (!user || String(user.status || "").toUpperCase() !== "ACTIVE" || String(user.email) !== String(session.email)) {
		throw new WorkdriveError("UNAUTHENTICATED", "Your session is no longer valid. Please sign in again.", 401);
	}

	return {
		userId: session.email,
		email: session.email,
		displayName: user.display_name || session.display_name || null,
		sessionRowId: String(session.ROWID),
		userRowId: String(user.ROWID),
		wdRowId: String(user.wd_row_id)
	};
}

async function revokeSession(app, user) {
	try {
		await app.datastore().table(SESSIONS_TABLE).updateRow({ ROWID: String(user.sessionRowId), status: "REVOKED" });
	} catch (err) {
		throw storeError(err, "logout");
	}
}

module.exports = { loginUser, authenticate, revokeSession, findUserByEmail, USERS_TABLE, SESSIONS_TABLE, CONNECTIONS_TABLE };
