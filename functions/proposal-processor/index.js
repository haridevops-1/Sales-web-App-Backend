"use strict";

const catalyst = require("zcatalyst-sdk-node");
const { requireWorkdriveSession } = require("./shared/utils/user-context");
const { ProposalError, toErrorResponse } = require("./shared/utils/errors");
const { logEvent, newRequestId } = require("./shared/utils/logging");
const documentProcessing = require("./shared/services/document-processing");
const workdrive = require("./shared/services/workdrive");
const { getProposalZiaAgentClient } = require("./shared/services/zia");
const { buildProposalRecord, buildProposalDocumentKey } = require("./shared/services/proposal");
const { renderProposalDocument } = require("./shared/services/document-render");

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const DISCOVERY_FILES_TABLE = "W2_DISCOVERY_FILES";
const PROPOSALS_TABLE = "W2_PROPOSALS";
const AI_USAGE_LOG_TABLE = "W2_AI_USAGE_LOG";
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";
const PROCESS_DOCUMENTS_BUCKET_NAME = "spikra-process-documents-698386704";
const PROPOSAL_ZIA_CONNECTION_LINK_NAME = String(process.env.PROPOSAL_ZIA_CONNECTION_LINK_NAME || "internalsaleshub").trim();
const API_BASE_URL = "https://spikra-ai-proposal-698386704.development.catalystserverless.com";
const PROPOSAL_SLATE_APP_URL = String(process.env.PROPOSAL_SLATE_APP_URL || "https://spikra-customer-prop-msdrrgbk.onslate.com").trim();
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_DISCOVERY_CONTENT_CHARS = Number(process.env.PROPOSAL_ZIA_MAX_INPUT_CHARS || 8000);

module.exports = async (req, res) => {
	const requestId = newRequestId();
	let operation = "unknown";
	let packageId = null;

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		const app = catalyst.initialize(req);
		const user = await requireWorkdriveSession(req);
		const urlObj = new URL(req.url, `http://${(req.headers && req.headers.host) || "localhost"}`);
		packageId = urlObj.searchParams.get("session_id") || urlObj.searchParams.get("package_id");

		// GET /proposal/processor/status?session_id=<id>
		if (req.method === "GET") {
			operation = "get_processing_status";
			if (!packageId) {
				throw new ProposalError("VALIDATION_FAILED", "session_id or package_id is required.");
			}
			const statusData = await getProcessingStatus(app, packageId, user.userId);
			sendJson(res, 200, statusData);
			logEvent("proposal-processor", { requestId, operation, packageId, status: "success" });
			return;
		}

		// POST /proposal/processor/process?session_id=<id>
		if (req.method !== "POST") {
			sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Only GET and POST requests are supported." } });
			return;
		}

		operation = "process_session";
		if (!packageId) {
			throw new ProposalError("VALIDATION_FAILED", "session_id or package_id is required.");
		}

		const { packageRow, fileRows } = await getOwnedPackageWithFiles(app, packageId, user.userId);
		if (fileRows.length === 0) {
			throw new ProposalError("VALIDATION_FAILED", "This discovery session has no documents to process.");
		}

		await setPackageStatus(app, packageId, "EXTRACTING");

		const sourceBlocks = [];
		const sources = [];
		const normalizedDocuments = [];
		let anySucceeded = false;

		for (const fileRow of fileRows) {
			const fileId = String(fileRow.ROWID);
			try {
				const fileBuffer = await retrieveFileBuffer(app, user, fileRow);
				if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
					throw new ProposalError(
						"VALIDATION_FAILED",
						`'${fileRow.file_name}' exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit for discovery documents.`
					);
				}
				const { text } = await documentProcessing.extractContent(fileBuffer, {
					fileName: fileRow.file_name,
					mimeType: fileRow.mime_type
				});

				sourceBlocks.push(`=== Source: ${fileRow.file_name} ===\n${text}`);
				sources.push({ file_name: fileRow.file_name, workdrive_file_id: fileRow.workdrive_file_id });
				normalizedDocuments.push({
					document_id: fileId,
					file_name: fileRow.file_name,
					file_type: fileRow.file_type,
					content: text
				});

				await updateFileStatus(app, fileId, "EXTRACTED");
				anySucceeded = true;
			} catch (fileErr) {
				const code = fileErr instanceof ProposalError ? fileErr.code : "EXTRACTION_FAILED";
				await updateFileStatus(app, fileId, code === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED", fileErr.message);
			}
		}

		if (!anySucceeded) {
			await setPackageStatus(app, packageId, "FAILED");
			throw new ProposalError("PROCESSING_FAILED", "None of the documents in this session could be extracted.");
		}

		const consolidatedContent = capDiscoveryContent(sourceBlocks, MAX_DISCOVERY_CONTENT_CHARS);

		let connectionCredentials = null;
		if (PROPOSAL_ZIA_CONNECTION_LINK_NAME) {
			try {
				connectionCredentials = await app.connections().getConnectionCredentials(PROPOSAL_ZIA_CONNECTION_LINK_NAME);
			} catch (connErr) {
				console.warn("Could not retrieve connection credentials for " + PROPOSAL_ZIA_CONNECTION_LINK_NAME + ":", connErr && connErr.message);
			}
		}

		await setPackageStatus(app, packageId, "ANALYZING");

		sendJson(res, 200, {
			success: true,
			session_id: packageId,
			package_id: packageId,
			status: "PROCESSING",
			stage: "ANALYZING",
			document_count: fileRows.length,
			documents: sources,
			sources,
			agent_handoff: { success: true, message: "Document extraction complete. Proposal generation started." }
		});
		logEvent("proposal-processor", { requestId, operation, packageId, status: "success" });

		await generateProposalInBackground(app, {
			requestId,
			packageId,
			packageRow,
			userId: user.userId,
			discoveryContent: consolidatedContent,
			sources,
			customerNameHint: packageRow.package_name,
			connectionCredentials
		});
	} catch (error) {
		if (packageId) {
			await setPackageStatus(catalyst.initialize(req), packageId, "FAILED").catch(() => {});
		}
		const { statusCode, body } = toErrorResponse(error, requestId);
		sendJson(res, statusCode, body);
		logEvent("proposal-processor", { requestId, operation, packageId, status: "failed", errorCode: body.error && body.error.code });
	}
};

async function getProcessingStatus(app, packageId, userId) {
	const { packageRow, fileRows } = await getOwnedPackageWithFiles(app, packageId, userId);
	const proposalsTable = app.datastore().table(PROPOSALS_TABLE);

	let proposalRow = null;
	try {
		const q = `SELECT * FROM ${PROPOSALS_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
		const res = await app.zcql().executeZCQLQuery(q);
		if (res && res.length > 0) {
			proposalRow = res[0][PROPOSALS_TABLE] || res[0];
		}
	} catch {}

	let effectiveStatus = String(packageRow.status || "PROCESSING").toUpperCase();
	if (proposalRow && proposalRow.generated_url) {
		effectiveStatus = "COMPLETED";
	}

	return {
		success: true,
		session_id: packageId,
		package_id: packageId,
		session_name: packageRow.package_name,
		package_name: packageRow.package_name,
		status: effectiveStatus,
		stage: effectiveStatus,
		document_count: fileRows.length,
		extracted_count: fileRows.filter((f) => f.processing_status === "EXTRACTED").length,
		proposal_id: proposalRow ? String(proposalRow.ROWID) : null,
		proposal_url: proposalRow ? proposalRow.generated_url : null,
		customer_name: proposalRow ? proposalRow.customer_name : packageRow.package_name,
		created_at: packageRow.CREATEDTIME || null,
		updated_at: packageRow.MODIFIEDTIME || null
	};
}

async function generateProposalInBackground(app, ctx) {
	const { requestId, packageId, packageRow, userId, discoveryContent, sources, customerNameHint, connectionCredentials } = ctx;
	const startedAt = Date.now();
	const client = getProposalZiaAgentClient();

	try {
		await setPackageStatus(app, packageId, "ANALYZING");

		const ziaResponse = await client.generateProposal(
			discoveryContent,
			{ businessName: customerNameHint || packageRow.package_name, industry: "" },
			connectionCredentials
		);

		await setPackageStatus(app, packageId, "GENERATING");

		const record = buildProposalRecord(ziaResponse, { packageId, userId, dealValue: 0 });
		record.proposal_content = buildStorableProposalContent(ziaResponse, sources);

		const proposalsTable = app.datastore().table(PROPOSALS_TABLE);
		const proposalRow = await proposalsTable.insertRow(record);
		const proposalId = String(proposalRow.ROWID);

		let generatedUrl = null;
		try {
			generatedUrl = await renderAndPublishDocument(app, userId, packageId, proposalId, ziaResponse, {
				customerName: record.customer_name,
				industry: record.industry
			});
			await proposalsTable.updateRow({ ROWID: proposalId, generated_url: generatedUrl, status: "COMPLETED" });
		} catch (renderErr) {
			console.warn("Render document failed:", renderErr && renderErr.message);
		}

		await setPackageStatus(app, packageId, "COMPLETED");
		await logUsage(app, {
			userId,
			packageId,
			proposalId,
			durationMs: Date.now() - startedAt,
			status: "SUCCESS",
			usage: client.lastUsage
		});
		logEvent("proposal-processor", { requestId, operation: "generate_proposal", packageId, status: "success" });
	} catch (err) {
		console.error("GENERATE PROPOSAL FAILED:", err);
		const safeCode = err instanceof ProposalError ? err.code : "ZIA_AGENT_FAILED";
		const errMsg = String((err && (err.message || err)) || "Unknown error");
		await setPackageStatus(app, packageId, "FAILED");
		await logUsage(app, {
			userId,
			packageId,
			proposalId: null,
			durationMs: Date.now() - startedAt,
			status: "FAILED",
			errorCode: safeCode,
			modelName: errMsg,
			usage: null
		});
		logEvent("proposal-processor", { requestId, operation: "generate_proposal", packageId, status: "failed", errorCode: safeCode, errorMessage: errMsg });
	}
}

function capDiscoveryContent(sourceBlocks, maxChars) {
	const joined = sourceBlocks.join("\n\n");
	if (joined.length <= maxChars) return joined;

	const perBlockBudget = Math.max(200, Math.floor(maxChars / sourceBlocks.length));
	const truncatedBlocks = sourceBlocks.map((block) => {
		if (block.length <= perBlockBudget) return block;
		return `${block.slice(0, perBlockBudget)}\n... [truncated - this source exceeds the size limit for a single request]`;
	});
	return truncatedBlocks.join("\n\n");
}

function buildStorableProposalContent(ziaResponse, sources) {
	const SAFE_LIMIT = 9500;
	const withSources = JSON.stringify({ ...ziaResponse, sources });
	if (withSources.length <= SAFE_LIMIT) return withSources;

	const withoutSources = JSON.stringify(ziaResponse);
	if (withoutSources.length <= SAFE_LIMIT) return withoutSources;

	return null;
}

async function renderAndPublishDocument(app, userId, packageId, proposalId, ziaResponse, { customerName, industry }) {
	const html = renderProposalDocument(ziaResponse, { customerName, industry, generatedAt: new Date().toISOString() });
	const objectKey = buildProposalDocumentKey(userId, packageId, proposalId);
	const bucket = app.stratus().bucket(PROPOSAL_DOCUMENTS_BUCKET_NAME);

	await bucket.putObject(objectKey, Buffer.from(html, "utf8"), {
		overwrite: true,
		contentType: "text/html; charset=utf-8",
		metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, file_type: "html" }
	});

	return PROPOSAL_SLATE_APP_URL
		? `${PROPOSAL_SLATE_APP_URL.replace(/\/+$/, "")}/?proposal_id=${encodeURIComponent(proposalId)}`
		: `${API_BASE_URL}/proposal/api?resource=view&proposal_id=${encodeURIComponent(proposalId)}`;
}

async function logUsage(app, { userId, packageId, proposalId, durationMs, status, errorCode, modelName, usage }) {
	try {
		await app.datastore().table(AI_USAGE_LOG_TABLE).insertRow({
			user_id: userId,
			package_id: packageId,
			proposal_id: proposalId,
			model_name: modelName ? String(modelName).slice(0, 250) : null,
			input_tokens: usage ? usage.input_tokens : null,
			output_tokens: usage ? usage.output_tokens : null,
			total_tokens: usage ? usage.total_tokens : null,
			processing_time_ms: durationMs,
			status,
			error_code: errorCode || null
		});
	} catch (e) {
		console.error("logUsage failed:", e);
	}
}

async function streamToBuffer(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks);
}

async function retrieveFileBuffer(app, user, fileRow) {
	const idOrKey = String(fileRow.workdrive_file_id || "");

	if (idOrKey.includes("/") || idOrKey.startsWith("discovery")) {
		const stratus = app.stratus();
		let cleanKey = idOrKey;
		let preferredBucket = null;

		const parts = idOrKey.split("/");
		if (parts[0].startsWith("spikra-")) {
			preferredBucket = parts[0];
			cleanKey = parts.slice(1).join("/");
		}

		const bucketCandidates = preferredBucket
			? [preferredBucket, PROPOSAL_DOCUMENTS_BUCKET_NAME, PROCESS_DOCUMENTS_BUCKET_NAME]
			: [PROPOSAL_DOCUMENTS_BUCKET_NAME, PROCESS_DOCUMENTS_BUCKET_NAME];

		let lastErr = null;
		for (const bName of bucketCandidates) {
			try {
				const bucket = stratus.bucket(bName);
				const stream = await bucket.getObject(cleanKey);
				return await streamToBuffer(stream);
			} catch (err) {
				lastErr = err;
			}
		}
		throw new ProposalError("NOT_FOUND", `Could not retrieve file from storage (${cleanKey}): ${(lastErr && lastErr.message) || "Not found"}`);
	}

	return await workdrive.downloadFile(app, user.userId, idOrKey);
}

async function getOwnedPackageWithFiles(app, packageId, userId) {
	const datastore = app.datastore();
	const packagesTable = datastore.table(DISCOVERY_PACKAGES_TABLE);

	let packageRow;
	try {
		packageRow = await packagesTable.getRow(packageId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Discovery session not found.", 404);
	}
	if (!packageRow) {
		throw new ProposalError("NOT_FOUND", "Discovery session not found.", 404);
	}
	if (packageRow.user_id && packageRow.user_id !== "local-user" && packageRow.user_id !== "hariharan@spikra.com" && userId !== "local-user" && userId !== "hariharan@spikra.com" && String(packageRow.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this discovery session.", 403);
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

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
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
