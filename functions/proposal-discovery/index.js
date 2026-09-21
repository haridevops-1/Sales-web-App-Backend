"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
} catch {
	({ requireWorkdriveSession } = require("../../workspace2-proposal/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("../../workspace2-proposal/utils/errors"));
	({ logEvent, newRequestId } = require("../../workspace2-proposal/utils/logging"));
}

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const DISCOVERY_FILES_TABLE = "W2_DISCOVERY_FILES";

const SUPPORTED_FILE_EXTENSIONS = [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".txt"];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB - matches the practical ceiling for text-extractable discovery documents

// Package/file CRUD only - extraction happens in proposal-processor, generation in
// proposal-agent. Every read/write here is scoped to the calling user; ownership is
// re-checked on every access, never trusted from the request body.
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
		const user = await requireWorkdriveSession(req);
		const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const packageId = urlObj.searchParams.get("package_id");
		const action = String(urlObj.searchParams.get("action") || "").toLowerCase();

		if (req.method === "GET") {
			if (packageId) {
				operation = "get_package";
				const result = await getPackageWithFiles(app, packageId, user.userId);
				sendJson(res, 200, { success: true, package: result });
			} else {
				operation = "list_packages";
				const result = await listPackages(app, user.userId);
				sendJson(res, 200, { success: true, packages: result });
			}
			logEvent("proposal-discovery", { requestId, operation, status: "success" });
			return;
		}

		if (req.method === "POST") {
			const rawBody = await readRequestBody(req, 2 * 1024 * 1024);
			const body = parseJsonBody(rawBody);

			if (packageId && action === "add_files") {
				operation = "add_files";
				const result = await addFilesToPackage(app, packageId, user.userId, body.files);
				sendJson(res, 200, { success: true, package: result });
			} else {
				operation = "create_package";
				const result = await createPackage(app, user.userId, body);
				sendJson(res, 201, { success: true, package: result });
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
	if (!file.workdrive_file_id || !file.file_name) {
		throw new ProposalError("VALIDATION_FAILED", "Each file requires workdrive_file_id and file_name.");
	}
	const ext = String(file.file_name).toLowerCase().slice(String(file.file_name).lastIndexOf("."));
	if (!SUPPORTED_FILE_EXTENSIONS.includes(ext)) {
		throw new ProposalError(
			"UNSUPPORTED_FILE_TYPE",
			`'${file.file_name}' is not a supported file type. Supported: ${SUPPORTED_FILE_EXTENSIONS.join(", ")}.`
		);
	}
	// This is the frontend-reported size, a UX-only guard - proposal-processor re-checks
	// the actual downloaded buffer length before extraction, since this can't be trusted.
	if (Number(file.file_size) > MAX_FILE_SIZE_BYTES) {
		throw new ProposalError(
			"VALIDATION_FAILED",
			`'${file.file_name}' exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit for discovery files.`
		);
	}
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
		const fileRow = await filesTable.insertRow({
			package_id: packageId,
			workdrive_file_id: String(file.workdrive_file_id),
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
			workdrive_file_id: String(file.workdrive_file_id),
			file_name: String(file.file_name),
			file_type: String(file.file_type || "").trim(),
			mime_type: String(file.mime_type || "").trim(),
			file_size: Number(file.file_size) || 0,
			processing_status: "PENDING"
		});
	}

	return getPackageWithFiles(app, packageId, userId, packageRow);
}

// Ownership is checked on the package before touching the file row, and the file row
// itself is confirmed to actually belong to that package - a file_id from another
// package (even one the caller owns) is rejected the same as a straight-up NOT_FOUND.
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

// Every read of a specific package must prove the caller owns it - never trust a
// package_id alone. Returns the raw row (not the formatted API shape) for callers that
// need to keep working with it (e.g. addFilesToPackage).
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
	if (String(row.user_id) !== String(userId)) {
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
		package_id: String(packageRow.ROWID || packageId),
		user_id: packageRow.user_id,
		package_name: packageRow.package_name,
		status: packageRow.status,
		created_at: packageRow.CREATEDTIME || null,
		updated_at: packageRow.MODIFIEDTIME || null,
		files: fileRows.map(formatFileRow)
	};
}

// Listing is always scoped to the caller's own user_id - never returns another
// salesperson's packages, matching the mandatory isolation requirement.
async function listPackages(app, userId) {
	const query = `SELECT * FROM ${DISCOVERY_PACKAGES_TABLE} WHERE user_id = '${escapeQueryValue(userId)}' ORDER BY CREATEDTIME DESC`;
	let rows = [];
	try {
		const result = await app.zcql().executeZCQLQuery(query);
		rows = (result || []).map((item) => item[DISCOVERY_PACKAGES_TABLE] || item);
	} catch {}

	return rows.map((row) => ({
		package_id: String(row.ROWID),
		package_name: row.package_name,
		status: row.status,
		created_at: row.CREATEDTIME || null,
		updated_at: row.MODIFIEDTIME || null
	}));
}

function formatFileRow(row) {
	return {
		package_file_id: String(row.ROWID || ""),
		package_id: row.package_id,
		workdrive_file_id: row.workdrive_file_id,
		file_name: row.file_name,
		file_type: row.file_type,
		mime_type: row.mime_type,
		file_size: row.file_size,
		processing_status: row.processing_status || "PENDING"
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
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
