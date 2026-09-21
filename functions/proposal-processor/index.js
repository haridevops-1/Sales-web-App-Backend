"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, workdrive, documentProcessing;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	workdrive = require("./shared/services/workdrive");
	documentProcessing = require("./shared/services/document-processing");
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	workdrive = require("../../workspace2-proposal/services/workdrive");
	documentProcessing = require("../../workspace2-proposal/services/document-processing");
}

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const DISCOVERY_FILES_TABLE = "W2_DISCOVERY_FILES";
const PROPOSAL_AGENT_FUNCTION_NAME = "proposal-agent";
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB - matches proposal-discovery's own guard; the frontend-reported size can't be trusted, so the real downloaded buffer is checked here too

// Retrieves each selected WorkDrive file (via the calling user's own token), extracts
// and normalizes its content, consolidates it with source references preserved, then
// hands off to proposal-agent. Never invents content - only what the files contain.
module.exports = async (req, res) => {
	const requestId = newRequestId();
	const operation = "process_package";
	let packageId = null;

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Only POST requests are supported." } });
			return;
		}

		const app = catalyst.initialize(req);
		const user = await requireWorkdriveSession(req);
		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		packageId = urlObj.searchParams.get("package_id");
		if (!packageId) {
			throw new ProposalError("VALIDATION_FAILED", "package_id is required.");
		}

		const { packageRow, fileRows } = await getOwnedPackageWithFiles(app, packageId, user.userId);
		if (fileRows.length === 0) {
			throw new ProposalError("VALIDATION_FAILED", "This discovery package has no files to process.");
		}

		await setPackageStatus(app, packageId, "PROCESSING");

		const sourceBlocks = [];
		const sources = [];
		let anySucceeded = false;

		for (const fileRow of fileRows) {
			const fileId = String(fileRow.ROWID);
			try {
				const fileBuffer = await workdrive.downloadFile(app, user.userId, fileRow.workdrive_file_id);
				if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
					throw new ProposalError(
						"VALIDATION_FAILED",
						`'${fileRow.file_name}' exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit for discovery files.`
					);
				}
				const { text } = await documentProcessing.extractContent(fileBuffer, {
					fileName: fileRow.file_name,
					mimeType: fileRow.mime_type
				});
				sourceBlocks.push(`=== Source: ${fileRow.file_name} ===\n${text}`);
				sources.push({ file_name: fileRow.file_name, workdrive_file_id: fileRow.workdrive_file_id });
				await updateFileStatus(app, fileId, "EXTRACTED");
				anySucceeded = true;
			} catch (fileErr) {
				const code = fileErr instanceof ProposalError ? fileErr.code : "EXTRACTION_FAILED";
				await updateFileStatus(app, fileId, code === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED", fileErr.message);
			}
		}

		if (!anySucceeded) {
			await setPackageStatus(app, packageId, "FAILED");
			throw new ProposalError("PROCESSING_FAILED", "None of the files in this package could be processed.");
		}

		const consolidatedContent = sourceBlocks.join("\n\n");
		await setPackageStatus(app, packageId, "PROCESSED");

		// Hand off to proposal-agent using the SAME calling user's credential (app.functions()
		// invokes with CREDENTIAL_USER.user, confirmed in the SDK source) so its own
		// getCurrentUser() resolves to this same salesperson - not verified live yet.
		let agentResult = null;
		try {
			const rawResult = await app.functions().execute(PROPOSAL_AGENT_FUNCTION_NAME, {
				method: "POST",
				data: {
					package_id: packageId,
					discovery_content: consolidatedContent,
					sources,
					customer_name_hint: packageRow.package_name
				}
			});
			agentResult = typeof rawResult === "string" ? safeParseJson(rawResult) : rawResult;
		} catch (agentErr) {
			logEvent("proposal-processor", { requestId, operation, packageId, status: "agent_handoff_failed" });
			// Extraction itself still succeeded - report that clearly even if the handoff failed.
			sendJson(res, 200, {
				success: true,
				package_id: packageId,
				status: "PROCESSED",
				sources,
				agent_handoff: { success: false, message: "Could not start proposal generation. Try again." }
			});
			return;
		}

		sendJson(res, 200, {
			success: true,
			package_id: packageId,
			status: "PROCESSED",
			sources,
			agent_handoff: agentResult || { success: true }
		});
		logEvent("proposal-processor", { requestId, operation, packageId, status: "success" });
	} catch (error) {
		if (packageId) {
			await setPackageStatus(catalyst.initialize(req), packageId, "FAILED").catch(() => {});
		}
		const { statusCode, body } = toErrorResponse(error, requestId);
		sendJson(res, statusCode, body);
		logEvent("proposal-processor", { requestId, operation, packageId, status: "failed", errorCode: body.error && body.error.code });
	}
};

async function getOwnedPackageWithFiles(app, packageId, userId) {
	const datastore = app.datastore();
	const packagesTable = datastore.table(DISCOVERY_PACKAGES_TABLE);

	let packageRow;
	try {
		packageRow = await packagesTable.getRow(packageId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	}
	if (!packageRow) {
		throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	}
	if (String(packageRow.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this discovery package.", 403);
	}

	const query = `SELECT * FROM ${DISCOVERY_FILES_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' ORDER BY CREATEDTIME ASC`;
	let fileRows = [];
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		fileRows = (result || []).map((item) => item[DISCOVERY_FILES_TABLE] || item);
	} catch {}

	return { packageRow, fileRows };
}

async function setPackageStatus(app, packageId, status) {
	try {
		await app.datastore().table(DISCOVERY_PACKAGES_TABLE).updateRow({ ROWID: packageId, status });
	} catch {}
}

async function updateFileStatus(app, fileRowId, status, errorMessage) {
	try {
		const payload = { ROWID: fileRowId, processing_status: status };
		if (errorMessage) payload.error_message = String(errorMessage).slice(0, 2000);
		await app.datastore().table(DISCOVERY_FILES_TABLE).updateRow(payload);
	} catch {}
}

function safeParseJson(str) {
	try { return JSON.parse(str); } catch { return null; }
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

function setCorsHeaders(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (origin !== "https://spikra-ai-proposal-app.onslate.com") {
		res.setHeader("Access-Control-Allow-Origin", origin || "*");
	}
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
