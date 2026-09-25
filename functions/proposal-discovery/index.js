"use strict";

const catalyst = require("zcatalyst-sdk-node");
const path = require("path");
const crypto = require("crypto");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, setAllowOriginHeader;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	({ setAllowOriginHeader } = require("./shared/utils/cors"));
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
	({ setAllowOriginHeader } = require("../../workspace2-proposal/utils/cors"));
}

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const DISCOVERY_FILES_TABLE = "W2_DISCOVERY_FILES";
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";
const PROCESS_DOCUMENTS_BUCKET_NAME = "spikra-process-documents-698386704";

const SUPPORTED_FILE_EXTENSIONS = [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".txt", ".csv", ".md"];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB per file
const MAX_TOTAL_UPLOAD_SIZE = 120 * 1024 * 1024; // 120MB total

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
		packageId = urlObj.searchParams.get("package_id") || urlObj.searchParams.get("session_id");
		const action = String(urlObj.searchParams.get("action") || "").toLowerCase();

		if (req.method === "GET") {
			if (packageId) {
				operation = "get_session";
				const result = await getPackageWithFiles(app, packageId, user.userId);
				sendJson(res, 200, { success: true, session: result, package: result, session_id: result.session_id, package_id: result.package_id });
			} else {
				operation = "list_sessions";
				const result = await listPackages(app, user.userId);
				sendJson(res, 200, { success: true, sessions: result, packages: result });
			}
			logEvent("proposal-discovery", { requestId, operation, status: "success" });
			return;
		}

		if (req.method === "POST") {
			const rawContentType = String(req.headers["content-type"] || req.headers["Content-Type"] || "");

			if (rawContentType.toLowerCase().startsWith("multipart/form-data")) {
				const boundary = extractMultipartBoundary(rawContentType);
				if (!boundary) {
					throw new ProposalError("VALIDATION_FAILED", "Multipart boundary was not found in the request.");
				}
				const bodyBuffer = await readRawRequestBody(req, MAX_TOTAL_UPLOAD_SIZE);
				const formData = parseMultipartFormData(bodyBuffer, boundary);

				const effectiveAction = (action || formData.fields.action || "").toLowerCase();
				const effectivePackageId = packageId || formData.fields.package_id || formData.fields.session_id || null;

				if (effectivePackageId && effectiveAction === "add_files") {
					operation = "add_files_upload";
					const result = await addUploadedFilesToPackage(app, effectivePackageId, user.userId, formData.allFiles);
					sendJson(res, 200, { success: true, session: result, package: result, session_id: result.session_id, package_id: result.package_id });
				} else {
					operation = "create_session_upload";
					const defaultPkgName = formData.allFiles[0] ? path.parse(formData.allFiles[0].fileName).name : "Discovery Session";
					const sessionName = formData.fields.session_name || formData.fields.package_name || defaultPkgName;
					const result = await createPackageFromUpload(app, user.userId, sessionName, formData.allFiles);
					sendJson(res, 201, { success: true, session: result, package: result, session_id: result.session_id, package_id: result.package_id });
				}
			} else {
				// JSON request body (direct JSON)
				const rawBody = await readRequestBody(req, 4 * 1024 * 1024);
				const body = parseJsonBody(rawBody);

				const effectivePackageId = packageId || body.package_id || body.session_id || null;
				if (effectivePackageId && action === "add_files") {
					operation = "add_files";
					const result = await addFilesToPackage(app, effectivePackageId, user.userId, body.files);
					sendJson(res, 200, { success: true, session: result, package: result, session_id: result.session_id, package_id: result.package_id });
				} else {
					operation = "create_session";
					const result = await createPackage(app, user.userId, body);
					sendJson(res, 201, { success: true, session: result, package: result, session_id: result.session_id, package_id: result.package_id });
				}
			}

			logEvent("proposal-discovery", { requestId, operation, packageId, status: "success" });
			return;
		}

		if (req.method === "DELETE") {
			const fileId = urlObj.searchParams.get("file_id");
			if (!packageId || !fileId) {
				throw new ProposalError("VALIDATION_FAILED", "package_id and file_id are required.");
			}
			operation = "remove_file";
			const result = await removeFileFromPackage(app, packageId, fileId, user.userId);
			sendJson(res, 200, { success: true, package: result });
			logEvent("proposal-discovery", { requestId, operation, packageId, status: "success" });
			return;
		}

		sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Only GET, POST and DELETE requests are supported." } });
	} catch (error) {
		const { statusCode, body } = toErrorResponse(error, requestId);
		sendJson(res, statusCode, body);
		logEvent("proposal-discovery", { requestId, operation, status: "failed", errorCode: body.error && body.error.code });
	}
};

function validateFileEntry(file) {
	if (!file || typeof file !== "object") {
		throw new ProposalError("VALIDATION_FAILED", "Each file must be an object.");
	}
	if (!file.file_name) {
		throw new ProposalError("VALIDATION_FAILED", "Each file requires file_name.");
	}
	const ext = String(file.file_name).toLowerCase().slice(String(file.file_name).lastIndexOf("."));
	if (!SUPPORTED_FILE_EXTENSIONS.includes(ext)) {
		throw new ProposalError(
			"UNSUPPORTED_FILE_TYPE",
			`'${file.file_name}' is not a supported file type. Supported: ${SUPPORTED_FILE_EXTENSIONS.join(", ")}.`
		);
	}
	if (Number(file.file_size) > MAX_FILE_SIZE_BYTES) {
		throw new ProposalError(
			"VALIDATION_FAILED",
			`'${file.file_name}' exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit for discovery files.`
		);
	}
}

async function uploadFileToStratus(app, packageId, file) {
	const stratus = app.stratus();
	const sanitized = path.basename(file.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
	const objectKey = `discovery/${packageId}/${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${sanitized}`;
	const contentType = file.contentType || "application/octet-stream";

	const bucketCandidates = [PROPOSAL_DOCUMENTS_BUCKET_NAME, PROCESS_DOCUMENTS_BUCKET_NAME];
	let lastErr = null;

	for (const bName of bucketCandidates) {
		try {
			const bucket = stratus.bucket(bName);
			await bucket.putObject(objectKey, file.data, {
				contentType,
				overwrite: true
			});
			return `${bName}/${objectKey}`;
		} catch (err) {
			lastErr = err;
		}
	}

	throw new ProposalError("STORAGE_ERROR", `Failed to upload file to storage: ${lastErr?.message || "Unknown error"}`);
}

async function createPackageFromUpload(app, userId, packageName, files) {
	const cleanName = String(packageName || "").trim();
	if (!cleanName) {
		throw new ProposalError("VALIDATION_FAILED", "package_name is required.");
	}
	if (!Array.isArray(files) || files.length === 0) {
		throw new ProposalError("VALIDATION_FAILED", "At least one file must be uploaded.");
	}

	for (const file of files) {
		const ext = path.extname(file.fileName).toLowerCase();
		if (!SUPPORTED_FILE_EXTENSIONS.includes(ext)) {
			throw new ProposalError("UNSUPPORTED_FILE_TYPE", `'${file.fileName}' is not a supported file type. Supported: ${SUPPORTED_FILE_EXTENSIONS.join(", ")}.`);
		}
		if (file.data.length > MAX_FILE_SIZE_BYTES) {
			throw new ProposalError("VALIDATION_FAILED", `'${file.fileName}' exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`);
		}
	}

	const datastore = app.datastore();
	const packagesTable = datastore.table(DISCOVERY_PACKAGES_TABLE);
	const filesTable = datastore.table(DISCOVERY_FILES_TABLE);

	const packageRow = await packagesTable.insertRow({
		user_id: userId,
		package_name: cleanName,
		status: "CREATED"
	});
	const packageId = String(packageRow.ROWID);

	const fileRows = [];
	for (const file of files) {
		const ext = path.extname(file.fileName).toLowerCase();
		const storageKey = await uploadFileToStratus(app, packageId, file);

		const fileRow = await filesTable.insertRow({
			package_id: packageId,
			workdrive_file_id: storageKey,
			storage_object_key: storageKey,
			source_type: "LOCAL_STORAGE",
			file_name: file.fileName,
			file_type: ext.replace(".", "").toUpperCase(),
			mime_type: file.contentType || "application/octet-stream",
			file_size: file.data.length,
			processing_status: "PENDING"
		});
		fileRows.push(fileRow);
	}

	return {
		package_id: packageId,
		user_id: userId,
		package_name: cleanName,
		status: "CREATED",
		files: fileRows.map(formatFileRow)
	};
}

async function addUploadedFilesToPackage(app, packageId, userId, files) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new ProposalError("VALIDATION_FAILED", "At least one file must be uploaded.");
	}
	const packageRow = await getOwnedPackageRow(app, packageId, userId);

	for (const file of files) {
		const ext = path.extname(file.fileName).toLowerCase();
		if (!SUPPORTED_FILE_EXTENSIONS.includes(ext)) {
			throw new ProposalError("UNSUPPORTED_FILE_TYPE", `'${file.fileName}' is not supported.`);
		}
	}

	const filesTable = app.datastore().table(DISCOVERY_FILES_TABLE);
	for (const file of files) {
		const ext = path.extname(file.fileName).toLowerCase();
		const storageKey = await uploadFileToStratus(app, packageId, file);

		await filesTable.insertRow({
			package_id: packageId,
			workdrive_file_id: storageKey,
			storage_object_key: storageKey,
			source_type: "LOCAL_STORAGE",
			file_name: file.fileName,
			file_type: ext.replace(".", "").toUpperCase(),
			mime_type: file.contentType || "application/octet-stream",
			file_size: file.data.length,
			processing_status: "PENDING"
		});
	}

	return getPackageWithFiles(app, packageId, userId, packageRow);
}

async function createPackage(app, userId, body) {
	const packageName = String(body.package_name || "").trim();
	if (!packageName) {
		throw new ProposalError("VALIDATION_FAILED", "package_name is required.");
	}
	const files = Array.isArray(body.files) ? body.files : [];
	files.forEach(validateFileEntry);

	const datastore = app.datastore();
	const packagesTable = datastore.table(DISCOVERY_PACKAGES_TABLE);
	const filesTable = datastore.table(DISCOVERY_FILES_TABLE);

	const packageRow = await packagesTable.insertRow({
		user_id: userId,
		package_name: packageName,
		status: "CREATED"
	});
	const packageId = String(packageRow.ROWID);

	const fileRows = [];
	for (const file of files) {
		let storageKey = String(file.workdrive_file_id || "");
		if (file.content) {
			const buf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.is_base64 !== false ? "base64" : "utf8");
			storageKey = await uploadFileToStratus(app, packageId, { fileName: file.file_name, data: buf, contentType: file.mime_type });
		}
		if (!storageKey) {
			storageKey = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		const fileRow = await filesTable.insertRow({
			package_id: packageId,
			workdrive_file_id: storageKey,
			storage_object_key: storageKey,
			source_type: "LOCAL_STORAGE",
			file_name: String(file.file_name),
			file_type: String(file.file_type || "").trim(),
			mime_type: String(file.mime_type || "").trim(),
			file_size: Number(file.file_size) || 0,
			processing_status: "PENDING"
		});
		fileRows.push(fileRow);
	}

	return {
		package_id: packageId,
		user_id: userId,
		package_name: packageName,
		status: "CREATED",
		files: fileRows.map(formatFileRow)
	};
}

async function addFilesToPackage(app, packageId, userId, files) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new ProposalError("VALIDATION_FAILED", "files must be a non-empty array.");
	}
	files.forEach(validateFileEntry);

	const packageRow = await getOwnedPackageRow(app, packageId, userId);
	const datastore = app.datastore();
	const filesTable = datastore.table(DISCOVERY_FILES_TABLE);

	for (const file of files) {
		await filesTable.insertRow({
			package_id: packageId,
			workdrive_file_id: String(file.workdrive_file_id || ""),
			storage_object_key: String(file.storage_object_key || file.workdrive_file_id || ""),
			source_type: String(file.source_type || "LOCAL_STORAGE"),
			file_name: String(file.file_name),
			file_type: String(file.file_type || "").trim(),
			mime_type: String(file.mime_type || "").trim(),
			file_size: Number(file.file_size) || 0,
			processing_status: "PENDING"
		});
	}

	return getPackageWithFiles(app, packageId, userId, packageRow);
}

async function removeFileFromPackage(app, packageId, fileId, userId) {
	const packageRow = await getOwnedPackageRow(app, packageId, userId);
	const filesTable = app.datastore().table(DISCOVERY_FILES_TABLE);

	let fileRow;
	try {
		fileRow = await filesTable.getRow(fileId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Discovery file not found.", 404);
	}
	if (!fileRow || String(fileRow.package_id) !== String(packageId)) {
		throw new ProposalError("NOT_FOUND", "Discovery file not found.", 404);
	}

	await filesTable.deleteRow(fileId);
	return getPackageWithFiles(app, packageId, userId, packageRow);
}

async function getOwnedPackageRow(app, packageId, userId) {
	if (!packageId) {
		throw new ProposalError("VALIDATION_FAILED", "package_id is required.");
	}
	const datastore = app.datastore();
	const packagesTable = datastore.table(DISCOVERY_PACKAGES_TABLE);

	let row;
	try {
		row = await packagesTable.getRow(packageId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	}
	if (!row) {
		throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	}
	if (row.user_id && String(row.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this discovery package.", 403);
	}
	return row;
}

async function getPackageWithFiles(app, packageId, userId, preloadedRow) {
	const packageRow = preloadedRow || (await getOwnedPackageRow(app, packageId, userId));
	const query = `SELECT * FROM ${DISCOVERY_FILES_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' ORDER BY CREATEDTIME ASC`;
	let fileRows = [];
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		fileRows = (result || []).map((item) => item[DISCOVERY_FILES_TABLE] || item);
	} catch {}

	return {
		session_id: String(packageRow.ROWID || packageId),
		package_id: String(packageRow.ROWID || packageId),
		session_name: packageRow.package_name,
		package_name: packageRow.package_name,
		user_id: packageRow.user_id,
		user_email: packageRow.user_id,
		status: packageRow.status,
		document_count: fileRows.length,
		created_at: packageRow.CREATEDTIME || null,
		updated_at: packageRow.MODIFIEDTIME || null,
		documents: fileRows.map(formatFileRow),
		files: fileRows.map(formatFileRow)
	};
}

async function listPackages(app, userId) {
	const query = `SELECT * FROM ${DISCOVERY_PACKAGES_TABLE} WHERE user_id = '${escapeQueryValue(userId)}' ORDER BY CREATEDTIME DESC`;
	let rows = [];
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		rows = (result || []).map((item) => item[DISCOVERY_PACKAGES_TABLE] || item);
	} catch {}

	return rows.map((row) => ({
		session_id: String(row.ROWID),
		package_id: String(row.ROWID),
		session_name: row.package_name,
		package_name: row.package_name,
		status: row.status,
		created_at: row.CREATEDTIME || null,
		updated_at: row.MODIFIEDTIME || null
	}));
}

function formatFileRow(row) {
	const id = String(row.ROWID || "");
	return {
		document_id: id,
		package_file_id: id,
		session_id: row.package_id,
		package_id: row.package_id,
		file_name: row.file_name,
		file_type: row.file_type,
		mime_type: row.mime_type,
		file_size: row.file_size,
		source_type: row.source_type || "LOCAL_STORAGE",
		storage_object_key: row.storage_object_key || row.workdrive_file_id,
		source_reference: row.storage_object_key || row.workdrive_file_id,
		workdrive_file_id: row.workdrive_file_id || row.storage_object_key,
		upload_status: "UPLOADED",
		extraction_status: row.processing_status || "PENDING",
		processing_status: row.processing_status || "PENDING"
	};
}

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

function extractMultipartBoundary(contentType) {
	const match = contentType.match(/boundary=([^;]+)/i);
	if (!match) return null;
	return match[1].trim().replace(/^"|"$/g, "");
}

function parseMultipartFormData(bodyBuffer, boundary) {
	const boundaryBuffer = Buffer.from(`--${boundary}`);
	const result = { fields: {}, allFiles: [] };
	let cursor = 0;

	while (cursor < bodyBuffer.length) {
		const boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, cursor);
		if (boundaryIndex === -1) break;

		cursor = boundaryIndex + boundaryBuffer.length;
		if (bodyBuffer[cursor] === 45 && bodyBuffer[cursor + 1] === 45) break;
		if (bodyBuffer[cursor] === 13 && bodyBuffer[cursor + 1] === 10) cursor += 2;

		const headersEnd = bodyBuffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
		if (headersEnd === -1) break;

		const headersText = bodyBuffer.subarray(cursor, headersEnd).toString("utf8");
		const headers = parsePartHeaders(headersText);
		const contentStart = headersEnd + 4;
		const nextBoundaryIndex = bodyBuffer.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
		if (nextBoundaryIndex === -1) break;

		const content = bodyBuffer.subarray(contentStart, nextBoundaryIndex);
		const disposition = headers["content-disposition"] || "";
		const nameMatch = disposition.match(/name="([^"]+)"/i);
		const fileNameMatch = disposition.match(/filename="([^"]*)"/i);

		if (nameMatch) {
			const fieldName = nameMatch[1];
			if (fileNameMatch && fileNameMatch[1]) {
				result.allFiles.push({
					fieldName,
					fileName: fileNameMatch[1],
					contentType: headers["content-type"] || "application/octet-stream",
					data: Buffer.from(content)
				});
			} else {
				result.fields[fieldName] = content.toString("utf8");
			}
		}

		cursor = nextBoundaryIndex + 2;
	}

	return result;
}

function parsePartHeaders(headersText) {
	const headers = {};
	for (const line of headersText.split("\r\n")) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
	}
	return headers;
}

function readRawRequestBody(req, maxSizeBytes) {
	if (req.body && Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
	if (req.rawBody && Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);

	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalSize = 0;
		let settled = false;
		const fail = (error) => { if (!settled) { settled = true; reject(error); } };

		req.on("data", (chunk) => {
			if (settled) return;
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalSize += buf.length;
			if (totalSize > maxSizeBytes) {
				fail(new ProposalError("VALIDATION_FAILED", `Upload exceeds the ${maxSizeBytes / (1024 * 1024)}MB limit.`));
				if (typeof req.destroy === "function") req.destroy();
				return;
			}
			chunks.push(buf);
		});
		req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
		req.on("error", fail);
		if (req.readableEnded || req.complete) {
			if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
		}
		if (typeof req.resume === "function" && req.isPaused && req.isPaused()) req.resume();
	});
}

function readRequestBody(req, maxSizeBytes) {
	return readRawRequestBody(req, maxSizeBytes).then((buf) => buf.toString("utf8"));
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
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
