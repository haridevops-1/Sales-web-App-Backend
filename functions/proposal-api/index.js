"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, workdrive, isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	workdrive = require("./shared/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey } = require("./shared/services/proposal"));
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	workdrive = require("../../workspace2-proposal/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey } = require("../../workspace2-proposal/services/proposal"));
}

const PROPOSALS_TABLE = "W2_PROPOSALS";
// Same Workspace-2-only bucket proposal-agent publishes rendered documents into.
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";

// Main HTTP API layer for Workspace 2: proposal listing/detail/status, the public
// rendered-document view, and WorkDrive folder/file browsing (once a user is
// connected). Every route except the public document view resolves the current user
// itself - never trusts a user_id from the request. Routes are distinguished by query
// params, not path segments (see workspace2-proposal/README.md's routing lesson - path
// info doesn't survive the API Gateway for Advanced I/O functions).
//
// Proposals are a shared, org-wide list once generated (every salesperson can see every
// generated proposal link and open it), but WorkDrive access and status changes stay
// strictly per-user - two different visibility rules for two different kinds of data,
// confirmed explicitly rather than assumed.
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
		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const resource = String(urlObj.searchParams.get("resource") || "proposals").toLowerCase();

		// Public: no session required. This is the shareable link handed back once a
		// proposal finishes generating - anyone with the link can open it, same as
		// Workspace 1's own generated experience links.
		if (resource === "view") {
			operation = "view_document";
			await handleViewProposal(app, urlObj, res);
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		const user = await requireWorkdriveSession(req);

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
				const proposal = await getProposalRow(app, proposalId);
				sendJson(res, 200, { success: true, proposal: formatProposal(proposal) });
			} else {
				// package_id lets the frontend resolve "the proposal that came out of
				// processing package X" after proposal-agent's background generation
				// finishes, without needing the proposal_id it was never handed (the
				// processor's own response only ever carries still_processing/package_id).
				// Org-wide list - not scoped to the caller, per the shared-visibility rule above.
				operation = "list_proposals";
				const proposals = await listProposals(app, packageIdFilter);
				sendJson(res, 200, { success: true, proposals });
			}
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		if (req.method === "POST" && proposalId) {
			// Status transitions stay owner-only, unlike read access - moving someone
			// else's proposal through review shouldn't be possible just because the list
			// itself is shared.
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

// Public document view - serves the static HTML proposal-agent rendered and published.
// No ownership check: this is the shareable link, same visibility model as the shared
// proposals list above.
async function handleViewProposal(app, urlObj, res) {
	const proposalId = String(urlObj.searchParams.get("proposal_id") || "").trim();
	if (!proposalId) {
		sendNotFoundHtml(res, "No proposal was specified.");
		return;
	}

	// The object key is user/package-scoped (see buildProposalDocumentKey), so the row
	// itself is the only source of truth for where its document lives - looked up here
	// rather than guessed, keeping the write and read paths from ever drifting apart.
	let row;
	try {
		row = await app.datastore().table(PROPOSALS_TABLE).getRow(proposalId);
	} catch {
		row = null;
	}
	if (!row || !row.user_id || !row.package_id) {
		sendNotFoundHtml(res, "This proposal could not be found.");
		return;
	}

	try {
		const objectKey = buildProposalDocumentKey(row.user_id, row.package_id, proposalId);
		const bucket = app.stratus().bucket(PROPOSAL_DOCUMENTS_BUCKET_NAME);
		const stream = await bucket.getObject(objectKey);
		const buffer = await streamToBuffer(stream);
		res.statusCode = 200;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.end(buffer);
	} catch {
		sendNotFoundHtml(res, "This proposal document could not be found. It may still be generating, or the link may be incorrect.");
	}
}

function sendNotFoundHtml(res, message) {
	res.statusCode = 404;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not Found | Spikra</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f2b3c;text-align:center;padding:24px}h1{font-size:1.5rem;margin-bottom:8px}p{color:#64748b;max-width:420px}</style>
</head><body><div><h1>Proposal not available</h1><p>${escapeHtmlText(message)}</p></div></body></html>`);
}

function escapeHtmlText(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function streamToBuffer(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

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

// Read access is org-wide (see the shared-visibility note above) - this only confirms
// the proposal exists, not who owns it. Ownership is still checked separately wherever
// a write happens (updateProposalStatus).
async function getProposalRow(app, proposalId) {
	const table = app.datastore().table(PROPOSALS_TABLE);
	let row;
	try {
		row = await table.getRow(proposalId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Proposal not found.", 404);
	}
	if (!row) throw new ProposalError("NOT_FOUND", "Proposal not found.", 404);
	return row;
}

async function listProposals(app, packageId) {
	const query = packageId
		? `SELECT * FROM ${PROPOSALS_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' ORDER BY CREATEDTIME DESC`
		: `SELECT * FROM ${PROPOSALS_TABLE} ORDER BY CREATEDTIME DESC`;
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
	const row = await getProposalRow(app, proposalId);
	if (String(row.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "Only the proposal's creator can change its status.", 403);
	}
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
		generated_url: row.generated_url || null,
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
