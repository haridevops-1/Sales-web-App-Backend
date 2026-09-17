
"use strict";

/**
 * Shared datastore module enforcing strictly targeted, single-row queries.
 * No bulk reads or unindexed scans are allowed.
 */

function escapeQueryValue(value) {
	return String(value || "").replace(/'/g, "''");
}

/**
 * Retrieves a single DOCUMENT row by its ROWID.
 */
async function getDocument(datastore, documentId) {
	if (!datastore || !documentId) return null;
	const table = datastore.table("DOCUMENTS");
	try {
		return await table.getRow(String(documentId));
	} catch {
		return null;
	}
}

/**
 * Retrieves a single PROJECT row by its ROWID.
 */
async function getProject(datastore, projectId) {
	if (!datastore || !projectId) return null;
	const table = datastore.table("PROJECTS");
	try {
		return await table.getRow(String(projectId));
	} catch {
		return null;
	}
}

/**
 * Finds the latest PROCESSING_JOBS row for a given document and job_type using targeted query with LIMIT 1.
 */
async function findProcessingJob(app, documentId, jobType) {
	if (!app || typeof app.zcql !== "function" || !documentId) {
		return null;
	}

	const query = `
		SELECT ROWID, status, attempt_count, job_type, experience_id, project_id, document_id
		FROM PROCESSING_JOBS
		WHERE document_id = '${escapeQueryValue(documentId)}'
		AND job_type = '${escapeQueryValue(jobType)}'
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
	} catch {
		return null;
	}

	return null;
}

/**
 * Finds the latest EXPERIENCES row for a given document and project using targeted query with LIMIT 1.
 */
async function findExperience(app, documentId, projectId) {
	if (!app || typeof app.zcql !== "function" || !documentId) {
		return null;
	}

	const query = `
		SELECT ROWID, status, content_object_key, experience_title, business_name, version_number
		FROM EXPERIENCES
		WHERE document_id = '${escapeQueryValue(documentId)}'
		AND project_id = '${escapeQueryValue(projectId)}'
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
			return row.EXPERIENCES || row;
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Safely extracts ROWID from a Catalyst row object.
 */
function getRowId(row) {
	if (!row) return "";
	const unwrapped = row.PROCESSING_JOBS || row.EXPERIENCES || row.PROJECTS || row.DOCUMENTS || row;
	return String(unwrapped.ROWID || unwrapped.rowid || unwrapped.ROW_ID || unwrapped.id || "");
}

module.exports = {
	escapeQueryValue,
	getDocument,
	getProject,
	findProcessingJob,
	findExperience,
	getRowId
};
