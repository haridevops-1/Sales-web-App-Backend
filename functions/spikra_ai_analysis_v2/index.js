"use strict";

const catalyst = require("zcatalyst-sdk-node");

let getZiaAgentClient;
let getDocument;
let getProject;
let findProcessingJob;
let getRowId;
let streamToBuffer;
let sanitizeErrorMessage;

try {
	const agentModule = require("./shared/agent");
	getZiaAgentClient = agentModule.getZiaAgentClient;
	const datastoreModule = require("./shared/datastore/targetedQueries");
	getDocument = datastoreModule.getDocument;
	getProject = datastoreModule.getProject;
	findProcessingJob = datastoreModule.findProcessingJob;
	getRowId = datastoreModule.getRowId;
	const utilsModule = require("./shared/utils");
	streamToBuffer = utilsModule.streamToBuffer;
	sanitizeErrorMessage = utilsModule.sanitizeErrorMessage;
} catch {
	const agentModule = require("../../shared/agent");
	getZiaAgentClient = agentModule.getZiaAgentClient;
	const datastoreModule = require("../../shared/datastore/targetedQueries");
	getDocument = datastoreModule.getDocument;
	getProject = datastoreModule.getProject;
	findProcessingJob = datastoreModule.findProcessingJob;
	getRowId = datastoreModule.getRowId;
	const utilsModule = require("../../shared/utils");
	streamToBuffer = utilsModule.streamToBuffer;
	sanitizeErrorMessage = utilsModule.sanitizeErrorMessage;
}

const PROCESS_BUCKET_NAME = "spikra-process-documents-698386704";
const GENERATED_BUCKET_NAME = "spikra-generated-experiences-698386704";

const DOCUMENTS_TABLE = "DOCUMENTS";
const PROCESSING_JOBS_TABLE = "PROCESSING_JOBS";
const PROJECTS_TABLE = "PROJECTS";
const EXPERIENCES_TABLE = "EXPERIENCES";

// Catalyst Connection (Internal-Sales-Hub) used to authenticate to the Zia Agent Trigger API.
const ZIA_AGENT_CONNECTION_LINK_NAME = "internalsaleshub";

const MAX_DOCUMENT_TEXT_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1 MB

// Advanced I/O (not Basic I/O): analyzing a large document through the Zia Agent can take
// well beyond Basic I/O's execution-time ceiling, which was killing this function mid-call
// ("basicio Execution Time Exceeded") regardless of document size. Advanced I/O gives this the
// same longer execution budget Functions 1 and 5 already rely on for their own slow I/O.
module.exports = async (req, res) => {
	let app = null;
	let documentId = null;
	let aiAnalysisJob = null;
	let jobId = "";
	let responded = false;

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		if (req.method !== "POST") {
			sendJson(res, 405, { success: false, message: "Only POST requests are supported." });
			return;
		}

		const rawBody = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
		const requestData = parseJsonBody(rawBody);

		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		let rawDocumentId = requestData.document_id || requestData.documentId ||
			urlObj.searchParams.get("document_id") || urlObj.searchParams.get("documentId");

		documentId = String(rawDocumentId || "").trim();

		if (!documentId) {
			throw new ValidationError("document_id is required");
		}

		app = catalyst.initialize(req);
		const datastore = app.datastore();
		const stratus = app.stratus();

		const documentsTable = datastore.table(DOCUMENTS_TABLE);
		const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);
		const projectsTable = datastore.table(PROJECTS_TABLE);

		let documentRow;
		try {
			documentRow = await documentsTable.getRow(documentId);
		} catch {
			throw new NotFoundError("Document record not found");
		}

		if (!documentRow) {
			throw new NotFoundError("Document record not found");
		}

		const projectId = String(documentRow.project_id || "").trim();
		const contentObjectKey = String(
			documentRow.content_object_key ||
			`projects/${projectId}/documents/${documentId}/extracted-content.txt`
		).trim();

		if (!projectId) {
			throw new ProcessingError("The document record is missing project_id");
		}

		if (!contentObjectKey) {
			throw new ProcessingError("Extracted text object key is missing");
		}

		console.log(`Function 3 (Zia Agent Orchestration) processing document_id: ${documentId}, project_id: ${projectId}, content_key: ${contentObjectKey}`);

		let projectRow = null;
		try {
			projectRow = await projectsTable.getRow(projectId);
		} catch {
			projectRow = null;
		}

		const rawBusinessName = String(
			(projectRow && projectRow.business_name) ||
			documentRow.business_name ||
			"Spikra"
		).trim();
		const businessName = rawBusinessName.replace(/~\d+/g, "").trim() || "Spikra";

		const projectName = String(
			(projectRow && projectRow.project_name) ||
			documentRow.file_name ||
			"Customer Proposal"
		).trim();

		let logoAvailable = false;
		if (projectRow && projectRow.business_logo_object_key) {
			logoAvailable = true;
		}

		const analysisObjectKey = `projects/${projectId}/analysis/document-${documentId}-analysis.json`;

		aiAnalysisJob = await findProcessingJob(app, documentId, "AI_ANALYSIS");
		const wasAlreadyRunning = Boolean(aiAnalysisJob) && String(aiAnalysisJob.status || "").toUpperCase() === "RUNNING";

		if (!aiAnalysisJob) {
			const experienceId = await resolveExperienceId(app, documentId, projectId);
			try {
				aiAnalysisJob = await processingJobsTable.insertRow({
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					job_type: "AI_ANALYSIS",
					status: "RUNNING",
					attempt_count: 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
			} catch (jobInsertError) {
				console.log("Job insertion notice:", jobInsertError.message);
				aiAnalysisJob = await findProcessingJob(app, documentId, "AI_ANALYSIS");
			}
		}

		jobId = getRowId(aiAnalysisJob);

		// Idempotent: skip the Zia Agent call if analysis already exists in Stratus, so it never re-runs per document.
		try {
			const genBucket = stratus.bucket(GENERATED_BUCKET_NAME);
			const existingObj = await genBucket.getObject(analysisObjectKey);
			if (existingObj) {
				console.log(`Idempotent hit: analysis already exists at ${analysisObjectKey}. Returning cached AI analysis.`);
				sendJson(res, 200, {
					success: true,
					message: "Document analysis already exists",
					document_id: documentId,
					project_id: projectId,
					job_id: jobId,
					processing_status: "COMPLETED",
					job_status: "COMPLETED",
					analysis_object_key: analysisObjectKey,
					analysis_type: "ZIA_AGENT_ANALYSIS",
					agent_type: "ZIA_AGENT"
				});
				return;
			}
		} catch {}

		// A retry (e.g. after the client gave up waiting on a slow Agent call) must never trigger a
		// second concurrent Agent call for the same document - the first one is very likely still
		// genuinely running server-side even though the earlier HTTP response timed out client-side.
		// Report "still processing" instead until the job is stale enough to assume it's abandoned.
		if (wasAlreadyRunning) {
			const startedTimeRaw = String(aiAnalysisJob.started_time || "").trim();
			const startedAt = startedTimeRaw ? new Date(`${startedTimeRaw.replace(" ", "T")}Z`) : null;
			const elapsedMs = startedAt && !isNaN(startedAt.getTime()) ? (Date.now() - startedAt.getTime()) : Infinity;
			const STILL_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;

			if (elapsedMs < STILL_RUNNING_THRESHOLD_MS) {
				console.log(`AI_ANALYSIS job ${jobId} is still RUNNING (started ${Math.round(elapsedMs / 1000)}s ago) - reporting still-processing instead of re-invoking the Agent.`);
				sendJson(res, 200, {
					success: false,
					still_processing: true,
					message: "Analysis is still in progress. Please check back shortly.",
					document_id: documentId,
					project_id: projectId,
					job_id: jobId,
					processing_status: "PROCESSING",
					job_status: "RUNNING"
				});
				return;
			}

			console.log(`AI_ANALYSIS job ${jobId} has been RUNNING for ${Math.round(elapsedMs / 1000)}s - treating as abandoned and retrying.`);
		}

		await documentsTable.updateRow({
			ROWID: documentId,
			processing_status: "PROCESSING",
			error_message: ""
		});

		if (aiAnalysisJob && jobId) {
			await processingJobsTable.updateRow({
				ROWID: jobId,
				status: "RUNNING",
				attempt_count: Number(aiAnalysisJob.attempt_count || 0) + 1,
				started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
				error_message: ""
			});
		}

		let extractedTextResponse = null;
		try {
			const b = stratus.bucket(PROCESS_BUCKET_NAME);
			extractedTextResponse = await b.getObject(contentObjectKey);
		} catch {}

		if (!extractedTextResponse) {
			throw new NotFoundError("Extracted text object not found in Stratus");
		}

		const extractedTextBuffer = await streamToBuffer(extractedTextResponse);

		if (!extractedTextBuffer || extractedTextBuffer.length === 0) {
			throw new ProcessingError("Extracted text is empty");
		}

		if (extractedTextBuffer.length > MAX_DOCUMENT_TEXT_SIZE) {
			throw new ProcessingError("The extracted text exceeds the supported size limit");
		}

		const documentText = extractedTextBuffer.toString("utf8").trim();

		if (!documentText) {
			throw new ProcessingError("Extracted text is empty");
		}

		console.log(`Extracted text read successfully: ${documentText.length} characters`);

		let connectionCredentials;
		try {
			connectionCredentials = await app.connections().getConnectionCredentials(ZIA_AGENT_CONNECTION_LINK_NAME);
		} catch (connErr) {
			throw new ProcessingError(`Zia Agent Catalyst Connection '${ZIA_AGENT_CONNECTION_LINK_NAME}' could not be resolved: ${connErr.message}`);
		}

		const agentClient = getZiaAgentClient();
		console.log(
			"Executing document analysis using Zia Agent client, endpoint_configured:",
			agentClient.isConfigured()
		);

		// The Agent call below has no fixed upper bound - it depends on document size and which
		// model is configured in Zia Agent Studio, and can exceed Catalyst's response-delivery
		// window even though the work itself reliably finishes (confirmed: the AI_ANALYSIS job
		// completes server-side even on requests that already returned 408 to the client). So the
		// client is answered now, before the slow part, instead of being left waiting through it -
		// the actual result is then picked up via a retry, which safely hits the idempotent check
		// or the still-processing guard above instead of ever re-invoking the Agent.
		sendJson(res, 200, {
			success: false,
			still_processing: true,
			message: "Analysis started. Larger documents or certain models can take a while - please check back shortly.",
			document_id: documentId,
			project_id: projectId,
			job_id: jobId,
			processing_status: "PROCESSING",
			job_status: "RUNNING"
		});
		responded = true;

		const structuredShowcase = await agentClient.analyzeDocument(documentText, {
			businessName,
			projectName,
			documentId,
			projectId,
			connectionCredentials
		});

		console.log(
			`Zia Agent analysis complete: ${structuredShowcase.capabilities ? structuredShowcase.capabilities.length : 0} capabilities, ${structuredShowcase.deliverable_cards ? structuredShowcase.deliverable_cards.length : 0} deliverable cards, session_id=${agentClient.lastSessionId || "none"}`
		);

		const analysisObject = {
			document_id: documentId,
			project_id: projectId,
			source_content_object_key: contentObjectKey,
			analysis_type: "ZIA_AGENT_ANALYSIS",
			agent_type: "ZIA_AGENT",
			agent_session_id: agentClient.lastSessionId || null,
			analyzed_at: new Date().toISOString(),
			branding: {
				logo_available: logoAvailable
			},
			...structuredShowcase,
			source_text_length: documentText.length
		};

		const analysisJsonBuffer = Buffer.from(JSON.stringify(analysisObject, null, 2), "utf8");

		const generatedBucket = stratus.bucket(GENERATED_BUCKET_NAME);

		try {
			await generatedBucket.putObject(analysisObjectKey, analysisJsonBuffer, {
				overwrite: true,
				contentType: "application/json; charset=utf-8",
				metaData: {
					project_id: projectId,
					document_id: documentId,
					analysis_type: "ZIA_AGENT_ANALYSIS",
					agent_type: "ZIA_AGENT"
				}
			});
			console.log(`Analysis JSON stored in Stratus at ${analysisObjectKey}`);
		} catch (uploadError) {
			console.log("Failed to store analysis JSON in Stratus:", uploadError.message);
			throw new ProcessingError("Failed to store analysis JSON in Stratus");
		}

		try {
			const updateDocData = {
				ROWID: documentId,
				processing_status: "COMPLETED",
				error_message: ""
			};
			if (documentRow.hasOwnProperty("analysis_object_key")) {
				updateDocData.analysis_object_key = analysisObjectKey;
			}
			await documentsTable.updateRow(updateDocData);
			console.log("DOCUMENTS row updated: processing_status = COMPLETED");
		} catch (docUpdateError) {
			console.log("DOCUMENTS status update failed:", docUpdateError.message);
			throw new ProcessingError("Failed to update document status in Data Store");
		}

		if (aiAnalysisJob && jobId) {
			try {
				await processingJobsTable.updateRow({
					ROWID: jobId,
					status: "COMPLETED",
					completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				console.log("PROCESSING_JOBS row updated: status = COMPLETED");
			} catch (jobUpdateError) {
				console.log("PROCESSING_JOBS status update failed:", jobUpdateError.message);
			}
		}

		try {
			await projectsTable.updateRow({
				ROWID: projectId,
				status: "PROCESSING"
			});
		} catch (projUpdateError) {
			console.log("PROJECTS status update notice:", projUpdateError.message);
		}

		// The client was already answered with still_processing before the Agent call started - it
		// (or a poll) picks up this COMPLETED state via the idempotent check on the next call.
		console.log(`AI analysis completed successfully in the background for document_id=${documentId}, analysis_object_key=${analysisObjectKey}`);
	} catch (error) {
		const safeErrorMessage = sanitizeErrorMessage(error);
		console.log("spikra_ai_analysis failed:", safeErrorMessage);

		// SchemaValidationError carries a shallow, size-bounded shape snapshot of the Agent's raw
		// response (no document text/secrets) - only way to see why hasMeaningfulShowcaseContent
		// rejected it.
		if (error && error.rawResponseSnapshot) {
			try {
				console.log("spikra_ai_analysis raw response snapshot:", JSON.stringify(error.rawResponseSnapshot));
				console.log("spikra_ai_analysis extracted output snapshot:", JSON.stringify(error.extractedOutputSnapshot));
			} catch (logErr) {
				console.log("spikra_ai_analysis snapshot logging failed:", logErr.message);
			}
		}

		await markProcessingFailure(app, documentId, aiAnalysisJob, safeErrorMessage);

		if (!responded) {
			sendJson(res, 200, {
				success: false,
				message: "AI analysis failed",
				document_id: documentId || "",
				processing_status: "FAILED",
				job_status: "FAILED",
				error: safeErrorMessage
			});
		} else {
			console.log(`AI analysis failed in the background after the still_processing response was already sent for document_id=${documentId}: ${safeErrorMessage}`);
		}
	}
};

// Catalyst's own CORS allowlist already injects Access-Control-Allow-Origin for
// spikra-ai-proposal-app.onslate.com (confirmed live - setting our own value on top of that produced
// "header contains multiple values" and the browser rejected the response outright). Every other
// origin (local dev, etc.) isn't in that allowlist, so it still needs our own header.
const CATALYST_COVERED_ORIGIN = "https://spikra-ai-proposal-app.onslate.com";

function setCorsHeaders(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (origin !== CATALYST_COVERED_ORIGIN) {
		res.setHeader("Access-Control-Allow-Origin", origin || "*");
	}
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readRequestBody(req, maxSizeBytes) {
	if (req.body && Buffer.isBuffer(req.body)) {
		return Promise.resolve(req.body.toString("utf8"));
	}
	if (req.body && typeof req.body === "string") {
		return Promise.resolve(req.body);
	}
	if (req.body && typeof req.body === "object") {
		return Promise.resolve(JSON.stringify(req.body));
	}
	if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
		return Promise.resolve(req.rawBody.toString("utf8"));
	}
	if (req.rawBody && typeof req.rawBody === "string") {
		return Promise.resolve(req.rawBody);
	}

	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalSize = 0;
		let settled = false;

		const fail = (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		};

		req.on("data", (chunk) => {
			if (settled) return;
			totalSize += chunk.length;
			if (totalSize > maxSizeBytes) {
				fail(new ValidationError(`Request body exceeds the ${maxSizeBytes} bytes limit.`));
				if (typeof req.destroy === "function") req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		});

		req.on("error", fail);

		if (req.readableEnded || req.complete) {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		}

		if (typeof req.resume === "function" && req.isPaused && req.isPaused()) {
			req.resume();
		}
	});
}

function parseJsonBody(bodyString) {
	if (!bodyString || !bodyString.trim()) {
		return {};
	}
	try {
		return JSON.parse(bodyString);
	} catch {
		try {
			const parsed = new URLSearchParams(bodyString);
			const obj = {};
			for (const [key, value] of parsed.entries()) {
				obj[key] = value;
			}
			return obj;
		} catch {
			return {};
		}
	}
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

async function resolveExperienceId(app, documentId, projectId) {
	if (!app || typeof app.zcql !== "function" || !documentId) {
		return "";
	}

	try {
		const extractJob = await findProcessingJob(app, documentId, "EXTRACT");
		if (extractJob && extractJob.experience_id) {
			return String(extractJob.experience_id);
		}

		const query = `
			SELECT ROWID
			FROM EXPERIENCES
			WHERE document_id = '${escapeQueryValue(documentId)}'
			ORDER BY CREATEDTIME DESC
			LIMIT 1
		`;
		const result = await app.zcql().executeZCQLQuery(query);
		let row = null;
		if (Array.isArray(result) && result.length > 0) {
			row = result[0];
		} else if (result && Array.isArray(result.data) && result.data.length > 0) {
			row = result.data[0];
		}

		if (row) {
			const exp = row.EXPERIENCES || row;
			return String(exp.ROWID || exp.rowid || "");
		}
	} catch {}

	return "";
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

async function markProcessingFailure(app, documentId, aiAnalysisJob, errorMessage) {
	if (!app || !documentId) {
		return;
	}

	const safeMsg = String(errorMessage || "AI document analysis failed.").slice(0, 9000);

	try {
		const datastore = app.datastore();
		const documentsTable = datastore.table(DOCUMENTS_TABLE);
		const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);

		await documentsTable.updateRow({
			ROWID: String(documentId),
			processing_status: "FAILED",
			error_message: safeMsg
		});

		const jobId = getRowId(aiAnalysisJob);
		if (jobId) {
			await processingJobsTable.updateRow({
				ROWID: jobId,
				status: "FAILED",
				completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
				error_message: safeMsg
			});
		}
	} catch (failureUpdateError) {
		console.error("Unable to update failure status:", failureUpdateError);
	}
}

class ValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}

class NotFoundError extends Error {
	constructor(message) {
		super(message);
		this.name = "NotFoundError";
	}
}

class ProcessingError extends Error {
	constructor(message) {
		super(message);
		this.name = "ProcessingError";
	}
}
