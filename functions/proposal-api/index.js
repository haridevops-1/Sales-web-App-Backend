"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, workdrive, isValidStatusTransition, VALID_STATUSES;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	workdrive = require("./shared/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES } = require("./shared/services/proposal"));
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	workdrive = require("../../workspace2-proposal/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES } = require("../../workspace2-proposal/services/proposal"));
}

const PROPOSALS_TABLE = "W2_PROPOSALS";

// Main HTTP API layer for Workspace 2: proposal listing/detail/status, and WorkDrive
// folder/file browsing (once a user is connected). Every route resolves the current
// user itself and re-checks ownership on every read/write - never trusts a user_id
// from the request. Routes are distinguished by query params, not path segments (see
// workspace2-proposal/README.md's routing lesson - path info doesn't survive the
// API Gateway for Advanced I/O functions).
module.exports = async (req, res) => {
	const requestId = newRequestId();
	let operation = "unknown";

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		const app = catalyst.initialize(req);
		const user = await requireWorkdriveSession(req);
		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const resource = String(urlObj.searchParams.get("resource") || "proposals").toLowerCase();

		if (resource === "workdrive") {
			operation = "workdrive_browse";
			await handleWorkdriveBrowse(app, user, urlObj, res);
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		// resource === "proposals" (default)
		const proposalId = urlObj.searchParams.get("proposal_id");
		const packageIdFilter = urlObj.searchParams.get("package_id");

		if (req.method === "GET") {
			if (proposalId) {
				operation = "get_proposal";
				const proposal = await getOwnedProposal(app, proposalId, user.userId);
				sendJson(res, 200, { success: true, proposal: formatProposal(proposal) });
			} else {
				// package_id lets the frontend resolve "the proposal that came out of
				// processing package X" after proposal-agent's background generation
				// finishes, without needing the proposal_id it was never handed (the
				// processor's own response only ever carries still_processing/package_id).
				operation = "list_proposals";
				const proposals = await listProposals(app, user.userId, packageIdFilter);
				sendJson(res, 200, { success: true, proposals });
			}
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		if (req.method === "POST" && proposalId) {
			operation = "update_status";
			const rawBody = await readRequestBody(req, 64 * 1024);
			const body = parseJsonBody(rawBody);
			const proposal = await updateProposalStatus(app, proposalId, user.userId, body.status);
			sendJson(res, 200, { success: true, proposal: formatProposal(proposal) });
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Unsupported method/resource combination." } });
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error, requestId);
		sendJson(res, statusCode, body);
		logEvent("proposal-api", { requestId, operation, status: "failed", errorCode: body.error && body.error.code });
	}
};

// Pure browsing here - connection status/authorize/disconnect all live in
// proposal-workdrive-auth-v2, not duplicated here (single owner per responsibility).
async function handleWorkdriveBrowse(app, user, urlObj, res) {
	const action = String(urlObj.searchParams.get("action") || "folders").toLowerCase();
	const folderId = urlObj.searchParams.get("folder_id");
	const fileId = urlObj.searchParams.get("file_id");

	if (action === "file" && fileId) {
		const metadata = await workdrive.getFileMetadata(app, user.userId, fileId);
		sendJson(res, 200, { success: true, file: metadata });
		return;
	}

	// action === "folders" or "files" - both list a folder's children; WorkDrive
	// distinguishes files vs folders within the returned items themselves. No folder_id
	// means the top level - the salesperson's own WorkDrive root, before they've drilled
	// into anything.
	const items = folderId
		? await workdrive.listFiles(app, user.userId, folderId)
		: await workdrive.listRootItems(app, user.userId);
	sendJson(res, 200, { success: true, items });
}

async function getOwnedProposal(app, proposalId, userId) {
	const table = app.datastore().table(PROPOSALS_TABLE);
	let row;
	try {
		row = await table.getRow(proposalId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Proposal not found.", 404);
	}
	if (!row) throw new ProposalError("NOT_FOUND", "Proposal not found.", 404);
	if (String(row.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this proposal.", 403);
	}
	return row;
}

async function listProposals(app, userId, packageId) {
	const conditions = [`user_id = '${escapeQueryValue(userId)}'`];
	if (packageId) conditions.push(`package_id = '${escapeQueryValue(packageId)}'`);
	const query = `SELECT * FROM ${PROPOSALS_TABLE} WHERE ${conditions.join(" AND ")} ORDER BY CREATEDTIME DESC`;
	let rows = [];
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		rows = (result || []).map((item) => item[PROPOSALS_TABLE] || item);
	} catch {}
	return rows.map(formatProposal);
}

async function updateProposalStatus(app, proposalId, userId, newStatus) {
	if (!VALID_STATUSES.includes(newStatus)) {
		throw new ProposalError("VALIDATION_FAILED", `status must be one of: ${VALID_STATUSES.join(", ")}.`);
	}
	const row = await getOwnedProposal(app, proposalId, userId);
	if (!isValidStatusTransition(row.status, newStatus)) {
		throw new ProposalError("VALIDATION_FAILED", `Cannot move a proposal from '${row.status}' to '${newStatus}'.`);
	}
	await app.datastore().table(PROPOSALS_TABLE).updateRow({ ROWID: proposalId, status: newStatus });
	return { ...row, status: newStatus };
}

function formatProposal(row) {
	let content = null;
	try {
		content = typeof row.proposal_content === "string" ? JSON.parse(row.proposal_content) : row.proposal_content;
	} catch {
		content = null;
	}
	return {
		proposal_id: String(row.ROWID || ""),
		package_id: row.package_id,
		customer_name: row.customer_name,
		industry: row.industry,
		proposal_title: row.proposal_title,
		status: row.status,
		deal_value: row.deal_value,
		content,
		created_at: row.CREATEDTIME || null,
		updated_at: row.MODIFIEDTIME || null
	};
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

function readRequestBody(req, maxSizeBytes) {
	if (req.body && Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
	if (req.body && typeof req.body === "string") return Promise.resolve(req.body);
	if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
	if (req.rawBody && Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody.toString("utf8"));
	if (req.rawBody && typeof req.rawBody === "string") return Promise.resolve(req.rawBody);

	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalSize = 0;
		let settled = false;
		const fail = (error) => { if (!settled) { settled = true; reject(error); } };

		req.on("data", (chunk) => {
			if (settled) return;
			totalSize += chunk.length;
			if (totalSize > maxSizeBytes) {
				fail(new ProposalError("VALIDATION_FAILED", `Request body exceeds the ${maxSizeBytes} bytes limit.`));
				if (typeof req.destroy === "function") req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
		req.on("error", fail);
		if (req.readableEnded || req.complete) {
			if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
		}
		if (typeof req.resume === "function" && req.isPaused && req.isPaused()) req.resume();
	});
}

function parseJsonBody(bodyString) {
	if (!bodyString || !bodyString.trim()) return {};
	try {
		return JSON.parse(bodyString);
	} catch {
		return {};
	}
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
