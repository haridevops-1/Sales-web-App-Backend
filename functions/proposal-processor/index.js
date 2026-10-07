"use strict";

const catalyst = require("zcatalyst-sdk-node");
let decodeSession, workdrive;
try {
	({ decodeSession } = require("./shared-workdrive/utils/session"));
	workdrive = require("./shared-workdrive/services/workdrive");
} catch {
	({ decodeSession } = require("../../shared-workdrive/utils/session"));
	workdrive = require("../../shared-workdrive/services/workdrive");
}

// See proposal-discovery/index.js for why: this function never touches WorkDrive
// itself (it only reads files already stored by proposal-discovery), so a session is
// only needed to scope packages to a salesperson when one connected. Packages created
// without a session live in this fixed, unscoped bucket instead.
const LOCAL_USER = { userId: "local-upload", email: null };
const { ProposalError, toErrorResponse } = require("./shared/utils/errors");
const { logEvent, newRequestId } = require("./shared/utils/logging");
const { setAllowOriginHeader } = require("./shared/utils/cors");
const documentProcessing = require("./shared/services/document-processing");
const { getProposalZiaAgentClient } = require("./shared/services/zia");
const { buildProposalRecord, buildProposalDocumentKey, buildLegacyProposalDocumentKey } = require("./shared/services/proposal");
const { renderAllDocuments, renderProposalDocument } = require("./shared/services/document-render");

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const DISCOVERY_FILES_TABLE = "W2_DISCOVERY_FILES";
const PROPOSALS_TABLE = "W2_PROPOSALS";
const AI_USAGE_LOG_TABLE = "W2_AI_USAGE_LOG";
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";
const PROCESS_DOCUMENTS_BUCKET_NAME = "spikra-process-documents-698386704";
const PROPOSAL_ZIA_CONNECTION_LINK_NAME = String(process.env.PROPOSAL_ZIA_CONNECTION_LINK_NAME || "internalsaleshub").trim();
const API_BASE_URL = "https://spikra-ai-proposal-698386704.development.catalystserverless.com";
const PROPOSAL_SLATE_APP_URL = String(process.env.PROPOSAL_SLATE_APP_URL || "https://spikra-w2-proposal-jmdbymcs.onslate.com").trim();
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
		const sessionUser = await decodeSession(req);
		const user = sessionUser || LOCAL_USER;
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

		// Idempotency: proposal already exists for this package - return it immediately
		const existingProposal = await findProposalByPackage(app, packageId);
		if (existingProposal && existingProposal.generated_url) {
			const existingId = String(existingProposal.ROWID);
			const existingDocs = buildDocumentsObject(existingId, existingProposal);
			let existingContent = null;
			try {
				existingContent = typeof existingProposal.proposal_content === "string" ? JSON.parse(existingProposal.proposal_content) : existingProposal.proposal_content;
			} catch {}

			sendJson(res, 200, {
				proposal_id: existingId,
				status: "COMPLETED",
				documents: existingDocs,
				technical_url: existingDocs.technical.url,
				commercial_url: existingDocs.commercial.url,
				tos_url: existingDocs.tos.url,
				source_documents: (existingContent && (existingContent.source_documents || existingContent.sources)) || [],
				consolidated_customer: (existingContent && existingContent.consolidated_customer) || null,
				technical_json: (existingContent && existingContent.technical_json) || null,
				commercial_json: (existingContent && existingContent.commercial_json) || null,
				tos_json: (existingContent && existingContent.tos_json) || null,
				success: true,
				session_id: packageId,
				package_id: packageId,
				proposal_url: existingDocs.commercial.url,
				customer_name: existingProposal.customer_name,
				proposal: {
					proposal_id: existingId,
					session_id: packageId,
					package_id: packageId,
					customer_name: existingProposal.customer_name,
					industry: existingProposal.industry,
					status: existingProposal.status || "COMPLETED",
					proposal_url: existingDocs.commercial.url,
					generated_url: existingDocs.commercial.url,
					technical_url: existingDocs.technical.url,
					commercial_url: existingDocs.commercial.url,
					tos_url: existingDocs.tos.url,
					documents: existingDocs,
					source_documents: (existingContent && (existingContent.source_documents || existingContent.sources)) || [],
					consolidated_customer: (existingContent && existingContent.consolidated_customer) || null,
					technical_json: (existingContent && existingContent.technical_json) || null,
					commercial_json: (existingContent && existingContent.commercial_json) || null,
					tos_json: (existingContent && existingContent.tos_json) || null
				}
			});
			logEvent("proposal-processor", { requestId, operation, packageId, status: "success", existing: true });
			return;
		}

		// Concurrency guard: if generation already in flight, do not trigger Agent again
		if (["PROCESSING", "ANALYZING", "GENERATING"].includes(String(packageRow.status || "").toUpperCase())) {
			const modifiedRaw = String(packageRow.MODIFIEDTIME || "").trim();
			const modifiedIso = modifiedRaw ? `${modifiedRaw.replace(" ", "T").replace(/:(\d{3})$/, ".$1")}Z` : "";
			const modifiedAt = modifiedIso ? new Date(modifiedIso) : null;
			const elapsedMs = modifiedAt && !isNaN(modifiedAt.getTime()) ? Date.now() - modifiedAt.getTime() : 0;
			if (elapsedMs < 300000) {
				sendJson(res, 200, {
					success: true,
					session_id: packageId,
					package_id: packageId,
					status: packageRow.status,
					message: "Proposal generation already in progress."
				});
				return;
			}
		}

		// Status Flow: CREATED -> PROCESSING -> ANALYZING -> GENERATING -> COMPLETED
		await setPackageStatus(app, packageId, "PROCESSING");

		const extractedDocs = [];
		const sources = [];
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
				const { kind, text } = await documentProcessing.extractContent(fileBuffer, {
					fileName: fileRow.file_name,
					mimeType: fileRow.mime_type
				});

				sources.push({ file_name: fileRow.file_name, workdrive_file_id: fileRow.workdrive_file_id });
				extractedDocs.push({
					file_id: fileId,
					file_name: fileRow.file_name,
					file_type: fileRow.file_type || kind,
					text
				});

				const extraFields = {};
				const resolvedKey = fileRow.storage_object_key || fileRow.workdrive_file_id || "";
				if (!fileRow.storage_object_key && resolvedKey) {
					extraFields.storage_object_key = resolvedKey;
				}
				if (!fileRow.source_type) {
					extraFields.source_type = "LOCAL_STORAGE";
				}
				await updateFileStatus(app, fileId, "EXTRACTED", null, extraFields);
				anySucceeded = true;
			} catch (fileErr) {
				const code = fileErr instanceof ProposalError ? fileErr.code : "EXTRACTION_FAILED";
				const extraFields = {};
				const resolvedKey = fileRow.storage_object_key || fileRow.workdrive_file_id || "";
				if (!fileRow.storage_object_key && resolvedKey) {
					extraFields.storage_object_key = resolvedKey;
				}
				if (!fileRow.source_type) {
					extraFields.source_type = "LOCAL_STORAGE";
				}
				await updateFileStatus(app, fileId, code === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED", fileErr.message, extraFields);
			}
		}

		if (!anySucceeded) {
			await setPackageStatus(app, packageId, "FAILED");
			throw new ProposalError("PROCESSING_FAILED", "None of the documents in this session could be extracted.");
		}

		// Combine all extracted information from 1 or N documents into Consolidated Customer JSON
		const { consolidated_json, consolidated_text } = documentProcessing.consolidateExtractedDocuments(extractedDocs, {
			sessionName: packageRow.package_name,
			businessName: packageRow.package_name
		});

		let connectionCredentials = null;
		if (PROPOSAL_ZIA_CONNECTION_LINK_NAME) {
			try {
				connectionCredentials = await app.connections().getConnectionCredentials(PROPOSAL_ZIA_CONNECTION_LINK_NAME);
			} catch (connErr) {
				console.warn("Could not retrieve connection credentials for " + PROPOSAL_ZIA_CONNECTION_LINK_NAME + ":", connErr && connErr.message);
			}
		}

		// Stage 1: Document extraction & consolidation done -> Trigger Agent (ONCE)
		await setPackageStatus(app, packageId, "ANALYZING");

		const startedAt = Date.now();
		const client = getProposalZiaAgentClient();

		const ziaResponse = await client.generateProposal(
			consolidated_json,
			{
				businessName: consolidated_json.customer?.company_name || packageRow.package_name,
				industry: consolidated_json.customer?.industry || ""
			},
			connectionCredentials
		);

		// Debug: log what the Agent returned (keys only, no sensitive data)
		console.log("[W2 Processor] Zia response received. Keys:", JSON.stringify(Object.keys(ziaResponse || {})));
		console.log("[W2 Processor] Documents present:", JSON.stringify({
			technical_document: Boolean(ziaResponse.technical_document),
			commercial_document: Boolean(ziaResponse.commercial_document),
			tos_document: Boolean(ziaResponse.tos_document)
		}));

		// Stage 2: Agent finished -> Hydrate 3 Separate Logical Templates (Technical, Commercial, TOS)
		await setPackageStatus(app, packageId, "GENERATING");

		const record = buildProposalRecord(ziaResponse, { packageId, userId: user.userId, dealValue: 0 });

		const proposalsTable = app.datastore().table(PROPOSALS_TABLE);
		const proposalRow = await proposalsTable.insertRow(record);
		const proposalId = String(proposalRow.ROWID);

		// Prepare the 3 distinct document JSON objects per Workspace 2 specification
		const technicalJson = {
			proposal_id: proposalId,
			document_type: "technical",
			customer_name: record.customer_name,
			industry: record.industry,
			content: ziaResponse.technical_document || { title: `${record.customer_name} — Technical Specification`, sections: [] }
		};

		const commercialJson = {
			proposal_id: proposalId,
			document_type: "commercial",
			customer_name: record.customer_name,
			industry: record.industry,
			content: ziaResponse.commercial_document || { title: `${record.customer_name} — Commercial Proposal`, sections: [] }
		};

		const tosJson = {
			proposal_id: proposalId,
			document_type: "tos",
			customer_name: record.customer_name,
			industry: record.industry,
			content: ziaResponse.tos_document || { title: `${record.customer_name} — Terms of Service & SLA`, sections: [] }
		};

		let documents = null;
		let primaryUrl = null;
		try {
			const published = await publishAllDocuments(app, user.userId, packageId, proposalId, ziaResponse, {
				customerName: record.customer_name,
				industry: record.industry,
				technicalJson,
				commercialJson,
				tosJson,
				consolidatedJson: consolidated_json
			});
			documents = published.documents;
			primaryUrl = published.primaryUrl;

			record.proposal_content = buildStorableProposalContent(
				ziaResponse,
				sources,
				consolidated_json,
				documents,
				technicalJson,
				commercialJson,
				tosJson
			);
			await proposalsTable.updateRow({
				ROWID: proposalId,
				generated_url: primaryUrl,
				status: "COMPLETED",
				proposal_content: record.proposal_content
			});
		} catch (renderErr) {
			console.warn("Render documents failed:", renderErr && renderErr.message);
			documents = buildDocumentsObject(proposalId);
			primaryUrl = documents.commercial.url;
			record.proposal_content = buildStorableProposalContent(
				ziaResponse,
				sources,
				consolidated_json,
				documents,
				technicalJson,
				commercialJson,
				tosJson
			);
			await proposalsTable.updateRow({ ROWID: proposalId, generated_url: primaryUrl, status: "COMPLETED", proposal_content: record.proposal_content });
		}

		// Stage 3: Complete session and log usage
		await setPackageStatus(app, packageId, "COMPLETED");
		await logUsage(app, {
			userId: user.userId,
			packageId,
			proposalId,
			durationMs: Date.now() - startedAt,
			status: "SUCCESS",
			modelName: client.lastModel || "Customer Proposal Generation Agent",
			usage: client.lastUsage
		});

		// Return final result matching Workspace 2 contract:
		// { proposal_id, status: "COMPLETED", documents: { technical, commercial, tos } }
		sendJson(res, 200, {
			proposal_id: proposalId,
			status: "COMPLETED",
			documents,
			technical_url: documents.technical.url,
			commercial_url: documents.commercial.url,
			tos_url: documents.tos.url,
			source_documents: sources,
			consolidated_customer: consolidated_json,
			technical_json: technicalJson,
			commercial_json: commercialJson,
			tos_json: tosJson,
			success: true,
			session_id: packageId,
			package_id: packageId,
			proposal_url: primaryUrl,
			customer_name: record.customer_name,
			proposal: {
				proposal_id: proposalId,
				session_id: packageId,
				package_id: packageId,
				customer_name: record.customer_name,
				industry: record.industry,
				status: "COMPLETED",
				proposal_url: primaryUrl,
				generated_url: primaryUrl,
				technical_url: documents.technical.url,
				commercial_url: documents.commercial.url,
				tos_url: documents.tos.url,
				documents,
				source_documents: sources,
				consolidated_customer: consolidated_json,
				technical_json: technicalJson,
				commercial_json: commercialJson,
				tos_json: tosJson,
				content: ziaResponse,
				source_document_count: sources.length,
				model_name: client.lastModel || "Customer Proposal Generation Agent",
				usage: client.lastUsage
			}
		});
		logEvent("proposal-processor", { requestId, operation, packageId, proposalId, status: "success" });
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

	let documents = null;
	if (proposalRow && proposalRow.ROWID) {
		documents = buildDocumentsObject(String(proposalRow.ROWID), proposalRow);
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
		documents,
		created_at: packageRow.CREATEDTIME || null,
		updated_at: packageRow.MODIFIEDTIME || null
	};
}

function buildDocumentUrl(proposalId, docType = "commercial") {
	const queryParam = docType ? `&type=${encodeURIComponent(docType)}` : "";
	if (PROPOSAL_SLATE_APP_URL) {
		return `${PROPOSAL_SLATE_APP_URL.replace(/\/+$/, "")}/?proposal_id=${encodeURIComponent(proposalId)}${queryParam}`;
	}
	return `${API_BASE_URL}/proposal/api?resource=view&proposal_id=${encodeURIComponent(proposalId)}${queryParam}`;
}

function buildDocumentsObject(proposalId, existingProposal) {
	if (existingProposal && existingProposal.proposal_content) {
		try {
			const parsed = typeof existingProposal.proposal_content === "string"
				? JSON.parse(existingProposal.proposal_content)
				: existingProposal.proposal_content;
			if (parsed && parsed.documents && parsed.documents.technical && parsed.documents.commercial && parsed.documents.tos) {
				return {
					technical: {
						type: "technical",
						name: parsed.documents.technical.name || "Technical Document",
						url: parsed.documents.technical.url || buildDocumentUrl(proposalId, "technical")
					},
					commercial: {
						type: "commercial",
						name: parsed.documents.commercial.name || "Commercial Proposal",
						url: parsed.documents.commercial.url || buildDocumentUrl(proposalId, "commercial")
					},
					tos: {
						type: "tos",
						name: parsed.documents.tos.name || "TOS Document",
						url: parsed.documents.tos.url || buildDocumentUrl(proposalId, "tos")
					}
				};
			}
		} catch {}
	}

	return {
		technical: {
			type: "technical",
			name: "Technical Document",
			url: buildDocumentUrl(proposalId, "technical")
		},
		commercial: {
			type: "commercial",
			name: "Commercial Proposal",
			url: buildDocumentUrl(proposalId, "commercial")
		},
		tos: {
			type: "tos",
			name: "TOS Document",
			url: buildDocumentUrl(proposalId, "tos")
		}
	};
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

function buildStorableProposalContent(ziaResponse, sources, consolidatedJson, documents, technicalJson, commercialJson, tosJson) {
	const SAFE_LIMIT = 9500;
	const fullPayload = {
		source_documents: sources,
		consolidated_customer: consolidatedJson,
		technical_json: technicalJson,
		commercial_json: commercialJson,
		tos_json: tosJson,
		technical_url: documents.technical.url,
		commercial_url: documents.commercial.url,
		tos_url: documents.tos.url,
		documents,
		technical_document: ziaResponse.technical_document,
		commercial_document: ziaResponse.commercial_document,
		tos_document: ziaResponse.tos_document,
		customer: ziaResponse.customer || (consolidatedJson && consolidatedJson.customer) || {}
	};
	let str = JSON.stringify(fullPayload);
	if (str.length <= SAFE_LIMIT) return str;

	const trimmedPayload = {
		source_documents: sources,
		technical_url: documents.technical.url,
		commercial_url: documents.commercial.url,
		tos_url: documents.tos.url,
		documents,
		technical_document: ziaResponse.technical_document,
		commercial_document: ziaResponse.commercial_document,
		tos_document: ziaResponse.tos_document,
		customer: ziaResponse.customer || (consolidatedJson && consolidatedJson.customer) || {}
	};
	str = JSON.stringify(trimmedPayload);
	if (str.length <= SAFE_LIMIT) return str;

	str = JSON.stringify({ documents, sources, technical_url: documents.technical.url, commercial_url: documents.commercial.url, tos_url: documents.tos.url });
	if (str.length <= SAFE_LIMIT) return str;

	return JSON.stringify({ documents });
}

async function publishAllDocuments(app, userId, packageId, proposalId, ziaResponse, { customerName, industry, technicalJson, commercialJson, tosJson, consolidatedJson }) {
	const renderedDocs = renderAllDocuments(ziaResponse, {
		customerName,
		industry,
		proposalId,
		generatedAt: new Date().toISOString()
	});

	const bucket = app.stratus().bucket(PROPOSAL_DOCUMENTS_BUCKET_NAME);

	const technicalKey = buildProposalDocumentKey(userId, packageId, proposalId, "technical");
	const commercialKey = buildProposalDocumentKey(userId, packageId, proposalId, "commercial");
	const tosKey = buildProposalDocumentKey(userId, packageId, proposalId, "tos");
	const legacyKey = buildLegacyProposalDocumentKey(userId, packageId, proposalId);

	const technicalJsonKey = buildProposalDocumentKey(userId, packageId, proposalId, "technical", "json");
	const commercialJsonKey = buildProposalDocumentKey(userId, packageId, proposalId, "commercial", "json");
	const tosJsonKey = buildProposalDocumentKey(userId, packageId, proposalId, "tos", "json");
	const consolidatedJsonKey = buildProposalDocumentKey(userId, packageId, proposalId, "consolidated", "json");

	// Upload all 3 HTML documents and JSON objects to Stratus
	await Promise.all([
		bucket.putObject(technicalKey, Buffer.from(renderedDocs.technical, "utf8"), {
			overwrite: true,
			contentType: "text/html; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "technical" }
		}),
		bucket.putObject(commercialKey, Buffer.from(renderedDocs.commercial, "utf8"), {
			overwrite: true,
			contentType: "text/html; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "commercial" }
		}),
		bucket.putObject(tosKey, Buffer.from(renderedDocs.tos, "utf8"), {
			overwrite: true,
			contentType: "text/html; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "tos" }
		}),
		// Keep index.html for backward compatibility (mirrors commercial proposal)
		bucket.putObject(legacyKey, Buffer.from(renderedDocs.commercial, "utf8"), {
			overwrite: true,
			contentType: "text/html; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "commercial" }
		}),
		bucket.putObject(technicalJsonKey, Buffer.from(JSON.stringify(technicalJson || {}, null, 2), "utf8"), {
			overwrite: true,
			contentType: "application/json; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "technical" }
		}),
		bucket.putObject(commercialJsonKey, Buffer.from(JSON.stringify(commercialJson || {}, null, 2), "utf8"), {
			overwrite: true,
			contentType: "application/json; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "commercial" }
		}),
		bucket.putObject(tosJsonKey, Buffer.from(JSON.stringify(tosJson || {}, null, 2), "utf8"), {
			overwrite: true,
			contentType: "application/json; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "tos" }
		}),
		bucket.putObject(consolidatedJsonKey, Buffer.from(JSON.stringify(consolidatedJson || {}, null, 2), "utf8"), {
			overwrite: true,
			contentType: "application/json; charset=utf-8",
			metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, doc_type: "consolidated" }
		})
	]);

	const documents = {
		technical: {
			type: "technical",
			name: "Technical Document",
			url: buildDocumentUrl(proposalId, "technical")
		},
		commercial: {
			type: "commercial",
			name: "Commercial Proposal",
			url: buildDocumentUrl(proposalId, "commercial")
		},
		tos: {
			type: "tos",
			name: "TOS Document",
			url: buildDocumentUrl(proposalId, "tos")
		}
	};

	return { documents, primaryUrl: documents.commercial.url };
}

async function logUsage(app, { userId, packageId, proposalId, durationMs, status, errorCode, modelName, usage }) {
	try {
		await app.datastore().table(AI_USAGE_LOG_TABLE).insertRow({
			user_id: userId,
			package_id: packageId,
			proposal_id: proposalId,
			model_name: modelName ? String(modelName).slice(0, 250) : "Customer Proposal Generation Agent",
			input_tokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null,
			output_tokens: usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null,
			total_tokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null,
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

	const { buffer } = await workdrive.downloadFile(app, user.userId, idOrKey, user);
	return buffer;
}

// Reads every row of a table through the Row API (getPagedRows - the same family as the
// single-row getRow, not the ZCQL query engine) and filters by package_id in memory. Used
// instead of a ZCQL SELECT because ZCQL can lag behind a just-committed write from the
// previous request; this table is scoped to one internal sales tool's discovery files, so
// a bounded full scan is cheap.
async function getFileRowsByPackageId(app, packageId, tableName) {
	const table = app.datastore().table(tableName);
	const targetId = String(packageId);
	const collected = [];
	let nextToken;

	for (let page = 0; page < 25; page++) {
		const response = await table.getPagedRows(nextToken ? { nextToken, maxRows: 200 } : { maxRows: 200 });
		const rows = Array.isArray(response && response.data) ? response.data : [];
		for (const row of rows) {
			if (String(row.package_id) === targetId) collected.push(row);
		}
		if (!response || !response.more_records || !response.next_token) break;
		nextToken = response.next_token;
	}

	collected.sort((a, b) => new Date(a.CREATEDTIME || 0) - new Date(b.CREATEDTIME || 0));
	return collected;
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
	if (packageRow.user_id && packageRow.user_id !== LOCAL_USER.userId && String(packageRow.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this discovery session.", 403);
	}

	// packagesTable.getRow() above is a direct ROWID lookup and is consistent immediately.
	// A ZCQL SELECT against this table is not: it runs through a separate query layer that
	// can briefly lag behind a write from the request that just created this package (seen
	// live: a package demonstrably created with 2 files reporting 0 here moments later) -
	// confirmed to persist even across several seconds of retried ZCQL reads. getFileRowsByPackageId
	// below reads through the Row API (the same family as getRow) instead of ZCQL, which does
	// not show that lag. The short retry around it is just a safety net, not the real fix.
	let fileRows = [];
	let lastQueryErr = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			fileRows = await getFileRowsByPackageId(app, packageId, DISCOVERY_FILES_TABLE);
			lastQueryErr = null;
		} catch (err) {
			lastQueryErr = err;
			fileRows = [];
		}
		if (fileRows.length > 0 || attempt === 3) break;
		await new Promise((resolve) => setTimeout(resolve, attempt * 400));
	}

	if (lastQueryErr) {
		console.error("[proposal-processor] Discovery files lookup failed after retries:", lastQueryErr.message);
	}

	return { packageRow, fileRows };
}

async function setPackageStatus(app, packageId, status) {
	try {
		await app.datastore().table(DISCOVERY_PACKAGES_TABLE).updateRow({ ROWID: packageId, status });
	} catch {}
}

async function updateFileStatus(app, fileRowId, status, errorMessage, extraFields = {}) {
	try {
		const payload = { ROWID: fileRowId, processing_status: status, ...extraFields };
		if (errorMessage) payload.error_message = String(errorMessage).slice(0, 2000);
		await app.datastore().table(DISCOVERY_FILES_TABLE).updateRow(payload);
	} catch {}
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

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

function setCorsHeaders(req, res) {
	setAllowOriginHeader(req, res);
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
