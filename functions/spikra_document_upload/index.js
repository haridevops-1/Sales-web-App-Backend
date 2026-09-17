"use strict";

const catalyst = require("zcatalyst-sdk-node");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");

const SOURCE_BUCKET_NAME = "spikra-process-documents-698386704";
const PROCESS_BUCKET_NAME = "spikra-process-documents-698386704";

const MAX_FILE_SIZE = 99 * 1024 * 1024; // 99 MB
// .doc (legacy binary Word format) is intentionally excluded - the text
// extraction library used in Function 2 only supports .docx (Office Open XML).
const ALLOWED_DOCUMENT_TYPES = {
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_LOGO_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/svg+xml"
];
const ALLOWED_LOGO_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];

const MAX_BUSINESS_NAME_LENGTH = 150;
const MAX_PROJECT_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;

module.exports = async (req, res) => {
	let app;
	let projectRow;
	let documentRow;
	let sourceObjectKey;
	let logoObjectKey = "";
	let safeLogoFileName = "";
	let uploadedLogo = null;

	try {
		setCorsHeaders(res);

		if (req.method === "OPTIONS") {
			return sendJson(res, 204, {});
		}

		if (req.method !== "POST") {
			return sendJson(res, 405, {
				success: false,
				message: "Only POST requests are supported."
			});
		}

		const contentType = getHeader(req, "content-type");

		if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
			return sendJson(res, 400, {
				success: false,
				message: "The request must use multipart/form-data."
			});
		}

		const boundary = extractMultipartBoundary(contentType);

		if (!boundary) {
			return sendJson(res, 400, {
				success: false,
				message: "Multipart boundary was not found in the request."
			});
		}

		const requestBody = await readRequestBody(req, MAX_FILE_SIZE + MAX_LOGO_SIZE + 2 * 1024 * 1024);

		const formData = parseMultipartFormData(requestBody, boundary);

		const businessName = getTextField(formData, "business_name");
		const projectName = getTextField(formData, "project_name");
		const description = getTextField(formData, "description") || "";
		const uploadedDocument = formData.files.document || formData.files.file;
		uploadedLogo = formData.files.business_logo || formData.files.logo;

		validateTextField(
			businessName,
			"business_name",
			MAX_BUSINESS_NAME_LENGTH
		);

		validateTextField(
			projectName,
			"project_name",
			MAX_PROJECT_NAME_LENGTH
		);

		if (description.length > MAX_DESCRIPTION_LENGTH) {
			throw new ValidationError(
				`description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`
			);
		}

		if (!uploadedDocument) {
			throw new ValidationError(
				"The document field is required."
			);
		}

		validateUploadedDocument(uploadedDocument);

		if (uploadedLogo) {
			validateUploadedLogo(uploadedLogo);
		}

		app = catalyst.initialize(req);

		const datastore = app.datastore();
		const stratus = app.stratus();

		const projectsTable = datastore.table("PROJECTS");
		const documentsTable = datastore.table("DOCUMENTS");
		const processingJobsTable = datastore.table("PROCESSING_JOBS");
		const experiencesTable = datastore.table("EXPERIENCES");

		const projectInsertData = {
			business_name: businessName,
			project_name: projectName,
			status: "PROCESSING",
			description
		};

		projectRow = await projectsTable.insertRow(projectInsertData);
		const projectId = String(projectRow.ROWID);

		if (uploadedLogo) {
			const logoExt = path.extname(uploadedLogo.fileName).toLowerCase();
			safeLogoFileName = createSafeFileName(uploadedLogo.fileName);
			logoObjectKey = `projects/${projectId}/branding/business-logo-${projectId}${logoExt}`;

			try {
				const sourceBucket = stratus.bucket(SOURCE_BUCKET_NAME);
				await sourceBucket.putObject(
					logoObjectKey,
					uploadedLogo.data,
					{
						overwrite: true,
						contentType: uploadedLogo.contentType
					}
				);

				console.log(`Logo uploaded to Stratus successfully at: ${logoObjectKey}`);

				try {
					await projectsTable.updateRow({
						ROWID: projectId,
						business_logo_object_key: logoObjectKey
					});
				} catch (projectLogoUpdateErr) {
					console.error("Warning: Failed to record logo key on PROJECTS row:", projectLogoUpdateErr.message);
				}
			} catch (sourceLogoErr) {
				console.error("Warning: Logo upload to Stratus failed:", sourceLogoErr.message);
				logoObjectKey = "";
			}
		}

		const documentExtension = path.extname(uploadedDocument.fileName).toLowerCase();
		const documentFileType = documentExtension === ".pdf" ? "PDF" : "DOCX";

		documentRow = await documentsTable.insertRow({
			project_id: projectId,
			source_type: "LOCAL_FILE",
			file_name: uploadedDocument.fileName,
			file_type: documentFileType,
			mime_type: uploadedDocument.contentType,
			file_size: uploadedDocument.data.length,
			storage_object_key: "",
			storage_object_path: "",
			source_url: "",
			processing_status: "UPLOADED",
			error_message: "",
			content_object_key: ""
		});

		const documentId = String(documentRow.ROWID);

		sourceObjectKey = `projects/${projectId}/documents/${documentId}/source${documentExtension}`;

		const sourceBucket = stratus.bucket(SOURCE_BUCKET_NAME);
		await sourceBucket.putObject(
			sourceObjectKey,
			uploadedDocument.data,
			{
				overwrite: true,
				contentType: uploadedDocument.contentType
			}
		);

		await documentsTable.updateRow({
			ROWID: documentId,
			storage_object_key: sourceObjectKey,
			storage_object_path: `${SOURCE_BUCKET_NAME}/${sourceObjectKey}`
		});

		const expInsertPayload = {
			project_id: projectId,
			document_id: documentId,
			business_name: businessName,
			experience_title: `${businessName} - ${projectName}`,
			status: "QUEUED",
			version_number: 1,
			error_message: ""
		};

		if (logoObjectKey) {
			expInsertPayload.business_logo_object_key = logoObjectKey;
		}

		const experienceRow = await experiencesTable.insertRow(expInsertPayload);
		const experienceId = String(experienceRow.ROWID);

		const processingJobRow = await processingJobsTable.insertRow({
			project_id: projectId,
			document_id: documentId,
			experience_id: experienceId,
			job_type: "EXTRACT",
			status: "QUEUED",
			attempt_count: 1,
			started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
			completed_time: null,
			error_message: ""
		});

		return sendJson(res, 201, {
			success: true,
			project_id: projectId,
			document_id: documentId,
			job_id: String(processingJobRow.ROWID),
			experience_id: experienceId,
			business_name: businessName,
			project_name: projectName,
			document_name: uploadedDocument.fileName,
			status: "UPLOADED"
		});
	} catch (error) {
		console.error("spikra_document_upload failed:", error);

		try {
			if (app && projectRow && projectRow.ROWID) {
				const datastore = app.datastore();
				const projectsTable = datastore.table("PROJECTS");

				await projectsTable.updateRow({
					ROWID: String(projectRow.ROWID),
					status: "FAILED"
				});
			}
		} catch (statusUpdateError) {
			console.error(
				"Unable to update project failure status:",
				statusUpdateError
			);
		}

		const statusCode =
			error instanceof ValidationError ? 400 : 500;

		return sendJson(res, statusCode, {
			success: false,
			message:
				error instanceof ValidationError
					? error.message
					: (error.message || "Document upload failed."),
			error_code:
				error instanceof ValidationError
					? "VALIDATION_ERROR"
					: "DOCUMENT_UPLOAD_ERROR"
		});
	}
};

function setCorsHeaders(res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader(
		"Access-Control-Allow-Headers",
		"Content-Type, Authorization"
	);
}

function getHeader(req, headerName) {
	if (!req.headers) {
		return "";
	}

	return req.headers[headerName] || req.headers[headerName.toLowerCase()] || "";
}

function extractMultipartBoundary(contentType) {
	const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);

	if (!boundaryMatch) {
		return null;
	}

	return boundaryMatch[1];
}

function readRequestBody(req, maximumSize) {
	if (req.body && Buffer.isBuffer(req.body)) {
		return Promise.resolve(req.body);
	}
	if (req.body && typeof req.body === "string") {
		return Promise.resolve(Buffer.from(req.body));
	}
	if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
		return Promise.resolve(req.rawBody);
	}
	if (req.rawBody && typeof req.rawBody === "string") {
		return Promise.resolve(Buffer.from(req.rawBody));
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
			if (settled) {
				return;
			}

			const bufferChunk = Buffer.isBuffer(chunk)
				? chunk
				: Buffer.from(chunk);

			totalSize += bufferChunk.length;

			if (totalSize > maximumSize) {
				fail(
					new ValidationError(
						`The request is too large. The maximum supported upload size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`
					)
				);

				if (typeof req.destroy === "function") {
					req.destroy();
				}

				return;
			}

			chunks.push(bufferChunk);
		});

		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks));
			}
		});

		req.on("error", fail);
		req.on("aborted", () => {
			fail(new Error("The upload request was aborted."));
		});

		if (req.readableEnded || req.complete) {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks));
			}
		}

		if (typeof req.resume === "function" && req.isPaused && req.isPaused()) {
			req.resume();
		}
	});
}

function parseMultipartFormData(bodyBuffer, boundary) {
	const boundaryBuffer = Buffer.from(`--${boundary}`);
	const result = {
		fields: {},
		files: {}
	};

	let cursor = 0;

	while (cursor < bodyBuffer.length) {
		const boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, cursor);

		if (boundaryIndex === -1) {
			break;
		}

		cursor = boundaryIndex + boundaryBuffer.length;

		if (
			bodyBuffer[cursor] === 45 &&
			bodyBuffer[cursor + 1] === 45
		) {
			break;
		}

		if (
			bodyBuffer[cursor] === 13 &&
			bodyBuffer[cursor + 1] === 10
		) {
			cursor += 2;
		}

		const headersEnd = bodyBuffer.indexOf(
			Buffer.from("\r\n\r\n"),
			cursor
		);

		if (headersEnd === -1) {
			throw new ValidationError(
				"Invalid multipart request headers."
			);
		}

		const headersBuffer = bodyBuffer.subarray(cursor, headersEnd);
		const headersText = headersBuffer.toString("utf8");
		const headers = parsePartHeaders(headersText);

		const contentStart = headersEnd + 4;
		const nextBoundaryIndex = bodyBuffer.indexOf(
			Buffer.from(`\r\n--${boundary}`),
			contentStart
		);

		if (nextBoundaryIndex === -1) {
			throw new ValidationError(
				"Invalid multipart request body."
			);
		}

		const content = bodyBuffer.subarray(
			contentStart,
			nextBoundaryIndex
		);

		const disposition = headers["content-disposition"] || "";
		const nameMatch = disposition.match(/name="([^"]+)"/i);
		const fileNameMatch = disposition.match(/filename="([^"]*)"/i);

		if (!nameMatch) {
			cursor = nextBoundaryIndex + 2;
			continue;
		}

		const fieldName = nameMatch[1];

		if (fileNameMatch && fileNameMatch[1]) {
			if (result.files.document && fieldName === "file") {
				cursor = nextBoundaryIndex + 2;
				continue;
			}
			result.files[fieldName] = {
				fileName: fileNameMatch[1],
				contentType:
					headers["content-type"] || "application/octet-stream",
				data: Buffer.from(content)
			};
		} else {
			result.fields[fieldName] = content.toString("utf8");
		}

		cursor = nextBoundaryIndex + 2;
	}

	return result;
}

function parsePartHeaders(headersText) {
	const headers = {};

	for (const line of headersText.split("\r\n")) {
		const separatorIndex = line.indexOf(":");

		if (separatorIndex === -1) {
			continue;
		}

		const headerName = line
			.slice(0, separatorIndex)
			.trim()
			.toLowerCase();

		const headerValue = line
			.slice(separatorIndex + 1)
			.trim();

		headers[headerName] = headerValue;
	}

	return headers;
}

function getTextField(formData, fieldName) {
	return String(formData.fields[fieldName] || "").trim();
}

function validateTextField(value, fieldName, maximumLength) {
	if (!value) {
		throw new ValidationError(
			`${fieldName} is required.`
		);
	}

	if (value.length > maximumLength) {
		throw new ValidationError(
			`${fieldName} cannot exceed ${maximumLength} characters.`
		);
	}
}

function validateUploadedDocument(file) {
	const extension = path.extname(file.fileName).toLowerCase();
	const expectedMimeType = ALLOWED_DOCUMENT_TYPES[extension];

	if (!expectedMimeType) {
		throw new ValidationError(
			"Only PDF or Word (.docx, .doc) documents are supported at this stage."
		);
	}

	if (file.contentType !== expectedMimeType) {
		throw new ValidationError(
			`The uploaded document must have the ${expectedMimeType} MIME type.`
		);
	}

	if (!file.data || file.data.length === 0) {
		throw new ValidationError(
			"The uploaded document is empty."
		);
	}

	if (file.data.length > MAX_FILE_SIZE) {
		throw new ValidationError(
			`The uploaded document exceeds the ${MAX_FILE_SIZE / (1024 * 1024)} MB size limit.`
		);
	}

	if (extension === ".pdf") {
		const pdfSignature = file.data.subarray(0, 5).toString("ascii");

		if (pdfSignature !== "%PDF-") {
			throw new ValidationError(
				"The uploaded file does not appear to be a valid PDF."
			);
		}
	} else if (extension === ".docx") {
		const zipSignature = file.data.subarray(0, 2).toString("ascii");

		if (zipSignature !== "PK") {
			throw new ValidationError(
				"The uploaded file does not appear to be a valid .docx document."
			);
		}
	}
}

function validateUploadedLogo(file) {
	if (!file || !file.data || file.data.length === 0) {
		throw new ValidationError("The uploaded logo is empty.");
	}

	if (file.data.length > MAX_LOGO_SIZE) {
		throw new ValidationError("Business logo exceeds the maximum allowed size of 5 MB.");
	}

	const extension = path.extname(file.fileName || "").toLowerCase();
	if (!ALLOWED_LOGO_EXTENSIONS.includes(extension)) {
		throw new ValidationError(`Unsupported logo extension: '${extension}'. Allowed extensions: .png, .jpg, .jpeg, .webp, .svg.`);
	}

	const contentType = String(file.contentType || "").toLowerCase();
	if (!ALLOWED_LOGO_MIME_TYPES.includes(contentType)) {
		throw new ValidationError(`Unsupported logo MIME type: '${contentType}'. Allowed types: image/png, image/jpeg, image/webp, image/svg+xml.`);
	}

	const sample = file.data.subarray(0, 100).toString("utf8").toLowerCase();
	if (sample.includes("<script") || sample.includes("<?php") || sample.includes("<!doctype html") || sample.includes("<html")) {
		throw new ValidationError("Invalid logo file: Scripts or HTML files are not permitted as logos.");
	}

	if (extension === ".png") {
		const pngSig = file.data.subarray(0, 8);
		if (pngSig.length < 8 || pngSig[0] !== 0x89 || pngSig[1] !== 0x50 || pngSig[2] !== 0x4E || pngSig[3] !== 0x47) {
			throw new ValidationError("The uploaded file does not appear to be a valid PNG image.");
		}
	} else if (extension === ".jpg" || extension === ".jpeg") {
		if (file.data.length < 3 || file.data[0] !== 0xFF || file.data[1] !== 0xD8 || file.data[2] !== 0xFF) {
			throw new ValidationError("The uploaded file does not appear to be a valid JPEG image.");
		}
	} else if (extension === ".webp") {
		const riff = file.data.subarray(0, 4).toString("ascii");
		const webp = file.data.subarray(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			throw new ValidationError("The uploaded file does not appear to be a valid WebP image.");
		}
	}
}

function createSafeFileName(originalFileName) {
	const extension = path.extname(originalFileName).toLowerCase();

	const baseName = path
		.basename(originalFileName, extension)
		.replace(/[^a-zA-Z0-9-_]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();

	return `${baseName || "document"}${extension}`;
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

class ValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}
