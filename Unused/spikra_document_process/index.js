"use strict";

const catalyst = require("zcatalyst-sdk-node");
const path = require("path");
const pdfParse = require("pdf-parse");
const PDFParser = require("pdf2json");
const mammoth = require("mammoth");

const DEFAULT_BUCKET_NAME = "spikra-process-documents-698386704";

const DOCUMENTS_TABLE = "DOCUMENTS";
const PROCESSING_JOBS_TABLE = "PROCESSING_JOBS";
const PROJECTS_TABLE = "PROJECTS";

const MAX_SOURCE_FILE_SIZE = 99 * 1024 * 1024; // 99 MB
const MAX_EXTRACTED_TEXT_SIZE = 10 * 1024 * 1024; // 10 MB

module.exports = async (context, basicIO) => {
	let app;
	let documentId = null;
	let processingJob = null;

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
		} catch (e) {
			throw new NotFoundError("Document record not found");
		}

		if (!documentRow) {
			throw new NotFoundError("Document record not found");
		}

		const projectId = String(documentRow.project_id || "").trim();
		const storageObjectKey = String(documentRow.storage_object_key || "").trim();

		if (!projectId) {
			throw new ProcessingError("The document record is missing project_id");
		}

		if (!storageObjectKey) {
			throw new ProcessingError("Original document storage key is missing");
		}

		const bucketName = getBucketName(documentRow);

		processingJob = await findExtractionJob(app, documentId);

		if (
			documentRow.processing_status === "EXTRACTED" &&
			documentRow.content_object_key
		) {
			try {
				const bucket = stratus.bucket(bucketName);
				const existingObj = await bucket.getObject(documentRow.content_object_key);
				if (existingObj) {
					basicIO.setStatus(200);
					basicIO.write(
						JSON.stringify({
							success: true,
							message: "Document was already processed",
							project_id: projectId,
							document_id: documentId,
							job_id: processingJob
								? String(processingJob.ROWID || processingJob.rowid || processingJob.ROW_ID || processingJob.id || "")
								: "",
							processing_status: "EXTRACTED",
							job_status: "COMPLETED",
							content_object_key: documentRow.content_object_key
						})
					);
					return;
				}
			} catch (idempotencyError) {}
		}

		await documentsTable.updateRow({
			ROWID: documentId,
			processing_status: "EXTRACTING",
			error_message: ""
		});

		if (processingJob) {
			const jobIdToUpdate = String(processingJob.ROWID || processingJob.rowid || processingJob.ROW_ID || processingJob.id || "");
			if (jobIdToUpdate) {
				await processingJobsTable.updateRow({
					ROWID: jobIdToUpdate,
					status: "RUNNING",
					attempt_count: Number(processingJob.attempt_count || 0) + 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
			}
		}

		let pdfResponse;
		try {
			const sourceBucket = stratus.bucket(bucketName);
			pdfResponse = await sourceBucket.getObject(storageObjectKey);
		} catch (stratusErr) {
			throw new NotFoundError("Original document not found in Stratus");
		}

		const sourceBuffer = await streamToBuffer(pdfResponse);

		if (!sourceBuffer || sourceBuffer.length === 0) {
			throw new ProcessingError("The downloaded document is empty");
		}

		if (sourceBuffer.length > MAX_SOURCE_FILE_SIZE) {
			throw new ProcessingError(`The document exceeds the ${MAX_SOURCE_FILE_SIZE / (1024 * 1024)} MB processing limit`);
		}

		const documentKind = getDocumentKind(documentRow, storageObjectKey);

		let extractedText = "";
		try {
			if (documentKind === "WORD") {
				extractedText = await extractWordText(sourceBuffer);
			} else {
				validatePdfSignature(sourceBuffer);
				extractedText = await extractPdfText(sourceBuffer);
			}
		} catch (parseError) {
			console.error("Document parsing failed:", parseError.message);
			throw parseError instanceof ProcessingError
				? parseError
				: new ProcessingError(`Failed to parse document: ${parseError.message}`);
		}

		const normalizedText = normalizeText(extractedText);

		if (!normalizedText) {
			throw new ProcessingError("No extractable text found in the document");
		}

		const extractedTextBuffer = Buffer.from(normalizedText, "utf8");

		if (extractedTextBuffer.length > MAX_EXTRACTED_TEXT_SIZE) {
			throw new ProcessingError("The extracted text is too large to store");
		}

		const contentObjectKey = `projects/${projectId}/documents/${documentId}/extracted-content.txt`;

		try {
			const targetBucket = stratus.bucket(bucketName);
			await targetBucket.putObject(contentObjectKey, extractedTextBuffer, {
				overwrite: true,
				contentType: "text/plain; charset=utf-8",
				metaData: {
					document_id: documentId,
					project_id: projectId,
					content_type: "extracted-text"
				}
			});
		} catch (uploadErr) {
			console.error(`Failed to upload extracted text to ${bucketName}:`, uploadErr.message);
			throw new ProcessingError("Failed to store extracted content");
		}

		const contentObjectPath = `${bucketName}/${contentObjectKey}`;

		try {
			const updateDocData = {
				ROWID: documentId,
				processing_status: "EXTRACTED",
				content_object_key: contentObjectKey,
				error_message: ""
			};
			if (documentRow.hasOwnProperty("content_object_path")) {
				updateDocData.content_object_path = contentObjectPath;
			}
			await documentsTable.updateRow(updateDocData);
		} catch (docUpdateErr) {
			console.error("DOCUMENTS status update failed:", docUpdateErr.message);
			throw new ProcessingError("Failed to update document processing status");
		}

		const jobId = processingJob
			? String(processingJob.ROWID || processingJob.rowid || processingJob.ROW_ID || processingJob.id || "")
			: "";
		if (processingJob && jobId) {
			await processingJobsTable.updateRow({
				ROWID: jobId,
				status: "COMPLETED",
				completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
				error_message: ""
			});
		}

		await projectsTable.updateRow({
			ROWID: projectId,
			status: "PROCESSING"
		});

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: true,
				message: "Document processed successfully",
				project_id: projectId,
				document_id: documentId,
				job_id: jobId,
				status: "EXTRACTED",
				processing_status: "EXTRACTED",
				job_status: "COMPLETED",
				content_object_key: contentObjectKey
			})
		);
	} catch (error) {
		context.log("spikra_document_process failed:", error.message);

		await markProcessingFailure(app, documentId, processingJob, error);

		const userErrorMessage = getSafeErrorMessage(error);

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: false,
				message: "Document processing failed",
				document_id: documentId || "",
				processing_status: "FAILED",
				job_status: "FAILED",
				error: userErrorMessage
			})
		);
	} finally {
		context.close();
	}
};

function getDocumentKind(documentRow, storageObjectKey) {
	const fileType = String((documentRow && documentRow.file_type) || "").trim().toUpperCase();
	if (fileType === "DOCX" || fileType === "DOC") {
		return "WORD";
	}
	if (fileType === "PDF") {
		return "PDF";
	}

	const extension = path.extname(storageObjectKey || (documentRow && documentRow.file_name) || "").toLowerCase();
	return extension === ".docx" || extension === ".doc" ? "WORD" : "PDF";
}

async function extractWordText(wordBuffer) {
	const result = await mammoth.extractRawText({ buffer: wordBuffer });
	return (result && result.value) || "";
}

function getBucketName(documentRow) {
	if (documentRow && documentRow.storage_object_path) {
		const parts = String(documentRow.storage_object_path).split("/");
		if (parts.length > 1 && parts[0]) {
			return parts[0];
		}
	}
	return DEFAULT_BUCKET_NAME;
}

async function findExtractionJob(app, documentId) {
	if (!app || typeof app.zcql !== "function" || !documentId) {
		return null;
	}

	const query = `
    SELECT ROWID, status, attempt_count, job_type
    FROM PROCESSING_JOBS
    WHERE document_id = '${escapeQueryValue(documentId)}'
    AND job_type = 'EXTRACT'
    ORDER BY CREATEDTIME DESC
    LIMIT 1
  `;

	try {
		const result = await app.zcql().executeZCQLQuery(query);

		let row = null;
		if (Array.isArray(result) && result.length > 0) {
			row = result[0];
		} else if (result && Array.isArray(result.data) && result.data.length > 0) {
			row = result.data[0];
		}

		if (row) {
			return row.PROCESSING_JOBS || row;
		}
	} catch (e) {
		return null;
	}

	return null;
}

function streamToBuffer(stream) {
	if (Buffer.isBuffer(stream)) {
		return Promise.resolve(stream);
	}
	return new Promise((resolve, reject) => {
		const chunks = [];

		stream.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		stream.on("end", () => {
			resolve(Buffer.concat(chunks));
		});

		stream.on("error", reject);
	});
}

// pdfjs-dist must run first: pdf-parse and pdf2json both fail outright (not just "no text found")
// on PDFs using compressed xref/object streams, which is the default output of most modern PDF writers.
async function extractPdfText(pdfBuffer) {
	const attempts = [];

	try {
		const text = await extractTextWithPdfJs(pdfBuffer);
		if (text && text.trim()) {
			return text;
		}
		attempts.push({ engine: "pdfjs-dist", error: null });
	} catch (e) {
		attempts.push({ engine: "pdfjs-dist", error: e });
		console.warn("pdfjs-dist extraction failed, attempting pdf-parse fallback:", e.message);
	}

	try {
		const parsedResult = await pdfParse(pdfBuffer);
		if (parsedResult && parsedResult.text && parsedResult.text.trim()) {
			return parsedResult.text;
		}
		attempts.push({ engine: "pdf-parse", error: null });
	} catch (e) {
		attempts.push({ engine: "pdf-parse", error: e });
		console.warn("pdf-parse extraction failed, attempting pdf2json fallback:", e.message);
	}

	try {
		const fallbackText = await extractTextWithPdf2Json(pdfBuffer);
		if (fallbackText && fallbackText.trim()) {
			return fallbackText;
		}
		attempts.push({ engine: "pdf2json", error: null });
	} catch (e) {
		attempts.push({ engine: "pdf2json", error: e });
		console.warn("pdf2json extraction failed:", e.message);
	}

	throw buildPdfExtractionError(attempts);
}

function buildPdfExtractionError(attempts) {
	const pdfjsAttempt = attempts.find((a) => a.engine === "pdfjs-dist");
	const pdfjsError = pdfjsAttempt && pdfjsAttempt.error;

	if (pdfjsError && pdfjsError.name === "PasswordException") {
		return new ProcessingError("This PDF is password-protected. Please upload a version without a password.");
	}

	if (pdfjsError && pdfjsError.name === "InvalidPDFException") {
		return new ProcessingError("The PDF file appears to be corrupted or invalid.");
	}

	const allEnginesErrored = attempts.length > 0 && attempts.every((a) => a.error);
	if (allEnginesErrored) {
		const lastError = attempts[attempts.length - 1].error;
		return new ProcessingError(`Failed to parse document: ${lastError.message}`);
	}

	return new ProcessingError(
		"No extractable text found in the document. It may be a scanned or image-only PDF with no selectable text."
	);
}

async function extractTextWithPdfJs(pdfBuffer) {
	if (typeof Promise.withResolvers !== "function") {
		Promise.withResolvers = function withResolvers() {
			let resolve;
			let reject;
			const promise = new Promise((res, rej) => {
				resolve = res;
				reject = rej;
			});
			return { promise, resolve, reject };
		};
	}

	const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(pdfBuffer),
		useWorkerFetch: false,
		isEvalSupported: false,
		disableFontFace: true
	});

	const doc = await loadingTask.promise;

	try {
		const pageTexts = [];
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const content = await page.getTextContent();
			pageTexts.push(content.items.map((item) => item.str || "").join(" "));
		}
		return pageTexts.join("\n");
	} finally {
		if (typeof doc.cleanup === "function") {
			await doc.cleanup();
		}
		if (typeof loadingTask.destroy === "function") {
			await loadingTask.destroy();
		}
	}
}

function extractTextWithPdf2Json(pdfBuffer) {
	return new Promise((resolve, reject) => {
		const parser = new PDFParser();

		parser.on("pdfParser_dataError", (errData) => {
			reject(new Error((errData && errData.parserError && errData.parserError.message) || "pdf2json parse error"));
		});

		parser.on("pdfParser_dataReady", () => {
			resolve(parser.getRawTextContent());
		});

		parser.parseBuffer(pdfBuffer);
	});
}

function validatePdfSignature(pdfBuffer) {
	const signature = pdfBuffer.subarray(0, 5).toString("ascii");

	if (signature !== "%PDF-") {
		throw new ProcessingError("Unsupported file type");
	}
}

function normalizeText(text) {
	return String(text || "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

function escapeQueryValue(value) {
	return String(value).replace(/'/g, "''");
}

async function markProcessingFailure(app, documentId, processingJob, error) {
	if (!app || !documentId) {
		return;
	}

	const userErrorMessage = getSafeErrorMessage(error);

	try {
		const datastore = app.datastore();
		const documentsTable = datastore.table(DOCUMENTS_TABLE);
		const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);

		await documentsTable.updateRow({
			ROWID: String(documentId),
			processing_status: "FAILED",
			error_message: userErrorMessage
		});

		const jobId = processingJob
			? String(processingJob.ROWID || processingJob.rowid || processingJob.ROW_ID || processingJob.id || "")
			: "";

		if (jobId) {
			await processingJobsTable.updateRow({
				ROWID: jobId,
				status: "FAILED",
				completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
				error_message: userErrorMessage
			});
		}
	} catch (failureUpdateError) {
		console.error("Unable to update failure status:", failureUpdateError);
	}
}

function getSafeErrorMessage(error) {
	if (
		error instanceof ValidationError ||
		error instanceof NotFoundError ||
		error instanceof ProcessingError
	) {
		return error.message;
	}

	return "Document processing failed";
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
