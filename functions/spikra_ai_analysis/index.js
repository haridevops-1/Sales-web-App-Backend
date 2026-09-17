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

const MAX_DOCUMENT_TEXT_SIZE = 10 * 1024 * 1024; // 10 MB

module.exports = async (context, basicIO) => {
	let app = null;
	let documentId = null;
	let aiAnalysisJob = null;
	let jobId = "";

	try {
		let rawDocumentId = basicIO.getArgument("document_id");
		if (!rawDocumentId) {
			rawDocumentId = basicIO.getArgument("documentId");
		}

		documentId = String(rawDocumentId || "").trim();

		if (!documentId) {
			throw new ValidationError("document_id is required");
		}

		app = catalyst.initialize(context);
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

		context.log(`Function 3 (Zia Agent Orchestration) processing document_id: ${documentId}, project_id: ${projectId}, content_key: ${contentObjectKey}`);

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
				context.log("Job insertion notice:", jobInsertError.message);
				aiAnalysisJob = await findProcessingJob(app, documentId, "AI_ANALYSIS");
			}
		}

		jobId = getRowId(aiAnalysisJob);

		// Idempotent: skip the Zia Agent call if analysis already exists in Stratus, so it never re-runs per document.
		try {
			const genBucket = stratus.bucket(GENERATED_BUCKET_NAME);
			const existingObj = await genBucket.getObject(analysisObjectKey);
			if (existingObj) {
				context.log(`Idempotent hit: analysis already exists at ${analysisObjectKey}. Returning cached AI analysis.`);
				basicIO.setStatus(200);
				basicIO.write(
					JSON.stringify({
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
					})
				);
				return;
			}
		} catch {}

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

		context.log(`Extracted text read successfully: ${documentText.length} characters`);

		const agentClient = getZiaAgentClient();
		context.log(
			"Executing document analysis using Zia Agent client, endpoint_configured:",
			agentClient.isConfigured()
		);

		const structuredShowcase = await agentClient.analyzeDocument(documentText, {
			businessName,
			projectName,
			documentId,
			projectId
		});

		context.log(
			`Zia Agent analysis complete: ${structuredShowcase.capabilities ? structuredShowcase.capabilities.length : 0} capabilities, ${structuredShowcase.deliverable_cards ? structuredShowcase.deliverable_cards.length : 0} deliverable cards`
		);

		const analysisObject = {
			document_id: documentId,
			project_id: projectId,
			source_content_object_key: contentObjectKey,
			analysis_type: "ZIA_AGENT_ANALYSIS",
			agent_type: "ZIA_AGENT",
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
			context.log(`Analysis JSON stored in Stratus at ${analysisObjectKey}`);
		} catch (uploadError) {
			context.log("Failed to store analysis JSON in Stratus:", uploadError.message);
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
			context.log("DOCUMENTS row updated: processing_status = COMPLETED");
		} catch (docUpdateError) {
			context.log("DOCUMENTS status update failed:", docUpdateError.message);
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
				context.log("PROCESSING_JOBS row updated: status = COMPLETED");
			} catch (jobUpdateError) {
				context.log("PROCESSING_JOBS status update failed:", jobUpdateError.message);
			}
		}

		try {
			await projectsTable.updateRow({
				ROWID: projectId,
				status: "PROCESSING"
			});
		} catch (projUpdateError) {
			context.log("PROJECTS status update notice:", projUpdateError.message);
		}

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: true,
				message: "AI analysis completed successfully",
				project_id: projectId,
				document_id: documentId,
				job_id: jobId,
				status: "COMPLETED",
				processing_status: "COMPLETED",
				job_status: "COMPLETED",
				analysis_object_key: analysisObjectKey,
				analysis_type: "ZIA_AGENT_ANALYSIS",
				agent_type: "ZIA_AGENT"
			})
		);
	} catch (error) {
		const safeErrorMessage = sanitizeErrorMessage(error);
		context.log("spikra_ai_analysis failed:", safeErrorMessage);

		await markProcessingFailure(app, documentId, aiAnalysisJob, safeErrorMessage);

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: false,
				message: "AI analysis failed",
				document_id: documentId || "",
				processing_status: "FAILED",
				job_status: "FAILED",
				error: safeErrorMessage
			})
		);
	} finally {
		context.close();
	}
};

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
