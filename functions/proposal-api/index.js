"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, workdrive, isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey, renderProposalDocument, setAllowOriginHeader;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	({ setAllowOriginHeader } = require("./shared/utils/cors"));
	workdrive = require("./shared/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey } = require("./shared/services/proposal"));
	({ renderProposalDocument } = require("./shared/services/document-render"));
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	({ setAllowOriginHeader } = require("../../workspace2-proposal/utils/cors"));
	workdrive = require("../../workspace2-proposal/services/workdrive");
	({ isValidStatusTransition, VALID_STATUSES, buildProposalDocumentKey } = require("../../workspace2-proposal/services/proposal"));
	({ renderProposalDocument } = require("../../workspace2-proposal/services/document-render"));
}

const PROPOSALS_TABLE = "W2_PROPOSALS";
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";
const PROCESS_DOCUMENTS_BUCKET_NAME = "spikra-process-documents-698386704";
const API_BASE_URL = "https://spikra-ai-proposal-698386704.development.catalystserverless.com";

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
		const urlObj = new URL(req.url, `http://${(req.headers && req.headers.host) || "localhost"}`);
		const resource = String(urlObj.searchParams.get("resource") || "proposals").toLowerCase();

		if (resource === "view") {
			operation = "view_document";
			await handleViewProposal(app, urlObj, res);
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		const user = await requireWorkdriveSession(req);

		if (resource === "workdrive") {
			operation = "workdrive_browse";
			sendJson(res, 200, { success: true, folders: [], files: [] });
			logEvent("proposal-api", { requestId, operation, status: "success" });
			return;
		}

		// resource === "proposals" or "proposal" (default)
		const proposalId = urlObj.searchParams.get("proposal_id");
		const sessionId = urlObj.searchParams.get("session_id") || urlObj.searchParams.get("package_id");

		if (req.method === "GET") {
			if (proposalId) {
				operation = "get_proposal";
				const proposal = await getProposalRow(app, proposalId);
				sendJson(res, 200, { success: true, proposal: formatProposal(proposal) });
			} else if (sessionId) {
				operation = "get_proposal_by_session";
				const proposal = await findProposalByPackage(app, sessionId);
				if (proposal) {
					sendJson(res, 200, { success: true, proposal: formatProposal(proposal) });
				} else {
					sendJson(res, 200, { success: false, message: "No proposal generated yet for this session.", session_id: sessionId });
				}
			} else {
				operation = "list_proposals";
				const proposals = await listProposals(app, sessionId);
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

async function streamToBuffer(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks);
}

async function handleViewProposal(app, urlObj, res) {
	const proposalId = String(urlObj.searchParams.get("proposal_id") || "").trim();
	if (!proposalId) {
		sendNotFoundHtml(res, "No proposal was specified.");
		return;
	}

	let row;
	try {
		row = await app.datastore().table(PROPOSALS_TABLE).getRow(proposalId);
	} catch {
		row = null;
	}
	if (!row) {
		row = await findProposalByPackage(app, proposalId);
	}
	if (!row) {
		sendNotFoundHtml(res, "This proposal could not be found.");
		return;
	}

	try {
		let buffer = null;
		if (row.user_id && row.package_id) {
			const realProposalId = String(row.ROWID || proposalId);
			const objectKeys = [
				buildProposalDocumentKey(row.user_id, row.package_id, realProposalId),
				buildProposalDocumentKey(row.user_id, row.package_id, proposalId)
			];
			const bucketCandidates = [PROPOSAL_DOCUMENTS_BUCKET_NAME, PROCESS_DOCUMENTS_BUCKET_NAME];
			for (const bName of bucketCandidates) {
				for (const objectKey of objectKeys) {
					try {
						const stream = await app.stratus().bucket(bName).getObject(objectKey);
						buffer = await streamToBuffer(stream);
						if (buffer && buffer.length > 0) break;
					} catch {}
				}
				if (buffer && buffer.length > 0) break;
			}
		}

		// Graceful on-the-fly rendering fallback if not found in Stratus
		if (!buffer && row.proposal_content) {
			let parsed = null;
			try {
				parsed = typeof row.proposal_content === "string" ? JSON.parse(row.proposal_content) : row.proposal_content;
			} catch {}

			if (parsed && typeof renderProposalDocument === "function") {
				const html = renderProposalDocument(parsed, {
					customerName: row.customer_name || "Customer",
					industry: row.industry || "",
					generatedAt: row.CREATEDTIME || new Date().toISOString()
				});
				buffer = Buffer.from(html, "utf8");
			}
		}

		if (buffer && buffer.length > 0) {
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			res.end(buffer);
			return;
		}

		sendNotFoundHtml(res, "This proposal document could not be found. It may still be generating, or the link may be incorrect.");
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

async function getProposalRow(app, proposalId) {
	try {
		const row = await app.datastore().table(PROPOSALS_TABLE).getRow(proposalId);
		if (row) return row;
	} catch {}
	const byPkg = await findProposalByPackage(app, proposalId);
	if (byPkg) return byPkg;
	throw new ProposalError("NOT_FOUND", "Proposal not found.", 404);
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
	if (row.user_id && String(row.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "Only the proposal creator can change its status.", 403);
	}
	if (!isValidStatusTransition(row.status, newStatus)) {
		throw new ProposalError("VALIDATION_FAILED", `Cannot move a proposal from '${row.status}' to '${newStatus}'.`);
	}
	await app.datastore().table(PROPOSALS_TABLE).updateRow({ ROWID: proposalId, status: newStatus });
	return { ...row, status: newStatus };
}

async function findProposalByPackage(app, packageId) {
	const query = `SELECT * FROM ${PROPOSALS_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		if (result && result.length > 0) {
			return result[0][PROPOSALS_TABLE] || result[0];
		}
	} catch {}
	return null;
}

function formatProposal(row) {
	let content = null;
	try {
		content = typeof row.proposal_content === "string" ? JSON.parse(row.proposal_content) : row.proposal_content;
	} catch {
		content = null;
	}
	const id = String(row.ROWID || "");
	const status = row.status || "Draft";
	return {
		proposal_id: id,
		session_id: row.package_id,
		package_id: row.package_id,
		user_id: row.user_id,
		customer_name: row.customer_name,
		industry: row.industry,
		proposal_title: row.proposal_title,
		status: status,
		proposal_status: status,
		deal_value: row.deal_value || 0,
		generated_url: sanitizeProposalUrl(row.generated_url, id),
		proposal_url: sanitizeProposalUrl(row.generated_url, id),
		proposal_data: content,
		content,
		source_document_count: row.source_document_count || (content && Array.isArray(content.sources) ? content.sources.length : null),
		model_name: row.model_name || "Customer Proposal Generation Agent",
		created_at: row.CREATEDTIME || null,
		updated_at: row.MODIFIEDTIME || null
	};
}

// Falls back to the real API view route (never a hardcoded onslate.com domain) when a
// proposal has no stored generated_url yet - the Slate app's own domain is read from
// PROPOSAL_SLATE_APP_URL wherever a URL first gets built (proposal-processor), so this
// function never needs to know or hardcode it.
function sanitizeProposalUrl(url, proposalId) {
	const trimmed = String(url || "").trim();
	if (trimmed) return trimmed;
	return `${API_BASE_URL}/proposal/api?resource=view&proposal_id=${encodeURIComponent(proposalId || "")}`;
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
			if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
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
	setAllowOriginHeader(req, res);
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
