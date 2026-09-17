'use strict';

const catalyst = require('zcatalyst-sdk-node');

const PROJECTS_TABLE = 'PROJECTS';
const DOCUMENTS_TABLE = 'DOCUMENTS';
const EXPERIENCES_TABLE = 'EXPERIENCES';
const PROCESSING_JOBS_TABLE = 'PROCESSING_JOBS';

/**
 * Basic I/O Entry Point for Function 6 (spikra_process_status).
 * Read-only status API for Spikra Customer Experience Engine.
 */
module.exports = async (context, basicIO) => {
	let projectId = '';
	let documentId = '';
	let experienceId = '';

	try {
		const app = catalyst.initialize(context);

		// Read input parameters from basicIO arguments
		projectId = String(
			basicIO.getArgument('project_id') ||
			basicIO.getArgument('projectId') ||
			''
		).trim();

		documentId = String(
			basicIO.getArgument('document_id') ||
			basicIO.getArgument('documentId') ||
			''
		).trim();

		experienceId = String(
			basicIO.getArgument('experience_id') ||
			basicIO.getArgument('experienceId') ||
			''
		).trim();

		// 1. Validate project_id
		if (!projectId) {
			basicIO.setStatus(400);
			basicIO.write(
				JSON.stringify({
					success: false,
					message: 'project_id is required'
				})
			);
			context.close();
			return;
		}

		// 2. Query PROJECTS record
		const projectQuery = `SELECT * FROM ${PROJECTS_TABLE} WHERE ROWID = '${escapeValue(projectId)}'`;
		const projectResult = await app.zcql().executeZCQLQuery(projectQuery);
		const projectRow = getRowData(projectResult, PROJECTS_TABLE);

		if (!projectRow) {
			basicIO.setStatus(404);
			basicIO.write(
				JSON.stringify({
					success: false,
					message: 'Project not found',
					project_id: projectId
				})
			);
			context.close();
			return;
		}

		// 3. Retrieve or Validate DOCUMENTS record
		let documentRow = null;
		if (documentId) {
			const documentQuery = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE ROWID = '${escapeValue(documentId)}'`;
			const documentResult = await app.zcql().executeZCQLQuery(documentQuery);
			documentRow = getRowData(documentResult, DOCUMENTS_TABLE);

			if (!documentRow) {
				basicIO.setStatus(404);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'Document not found',
						document_id: documentId
					})
				);
				context.close();
				return;
			}

			// Validate document ownership
			const docProjectId = String(documentRow.project_id || '').trim();
			if (docProjectId && docProjectId !== projectId) {
				basicIO.setStatus(400);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'The specified document does not belong to the project'
					})
				);
				context.close();
				return;
			}
		} else {
			// Find latest document for the project
			const docQuery = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE project_id = '${escapeValue(projectId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
			const docResult = await app.zcql().executeZCQLQuery(docQuery);
			documentRow = getRowData(docResult, DOCUMENTS_TABLE);
			if (documentRow) {
				documentId = getRowId(documentRow);
			}
		}

		// 4. Retrieve or Validate EXPERIENCES record
		let experienceRow = null;
		if (experienceId) {
			const experienceQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE ROWID = '${escapeValue(experienceId)}'`;
			const experienceResult = await app.zcql().executeZCQLQuery(experienceQuery);
			experienceRow = getRowData(experienceResult, EXPERIENCES_TABLE);

			if (!experienceRow) {
				basicIO.setStatus(404);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'Experience not found',
						experience_id: experienceId
					})
				);
				context.close();
				return;
			}

			// Validate experience ownership
			const expProjectId = String(experienceRow.project_id || '').trim();
			if (expProjectId && expProjectId !== projectId) {
				basicIO.setStatus(400);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'The specified experience does not belong to the project'
					})
				);
				context.close();
				return;
			}

			const expDocId = String(experienceRow.document_id || '').trim();
			if (documentId && expDocId && expDocId !== documentId) {
				basicIO.setStatus(400);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'The specified experience does not belong to the specified document'
					})
				);
				context.close();
				return;
			}
		} else {
			// Find latest experience for project / document
			let expQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE project_id = '${escapeValue(projectId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
			if (documentId) {
				expQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE project_id = '${escapeValue(projectId)}' AND document_id = '${escapeValue(documentId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
			}
			const expResult = await app.zcql().executeZCQLQuery(expQuery);
			experienceRow = getRowData(expResult, EXPERIENCES_TABLE);
			if (experienceRow) {
				experienceId = getRowId(experienceRow);
			}
		}

		// 5. Query PROCESSING_JOBS records
		const jobQuery = `SELECT * FROM ${PROCESSING_JOBS_TABLE} WHERE project_id = '${escapeValue(projectId)}' ORDER BY CREATEDTIME DESC`;
		const jobResult = await app.zcql().executeZCQLQuery(jobQuery);
		const jobRows = (jobResult || []).map((item) => item[PROCESSING_JOBS_TABLE] || item);

		// 6. Calculate current_stage and error_message
		const currentStage = determineCurrentStage(projectRow, documentRow, experienceRow, jobRows);
		const errorMessage = getPrioritizedErrorMessage(experienceRow, documentRow, jobRows);

		// 7. Format jobs list
		const jobsList = jobRows.map((job) => ({
			job_id: getRowId(job),
			job_type: job.job_type || 'UNKNOWN',
			status: job.status || 'UNKNOWN',
			attempt_count: Number(job.attempt_count || 1),
			started_time: job.started_time || null,
			completed_time: job.completed_time || null,
			error_message: job.error_message || null
		}));

		// 8. Build project response section
		const projectSection = {
			project_id: getRowId(projectRow) || projectId,
			business_name: projectRow.business_name || '',
			project_name: projectRow.project_name || '',
			status: projectRow.status || 'UNKNOWN'
		};

		// 9. Build document response section
		const documentSection = documentRow ? {
			document_id: getRowId(documentRow) || documentId,
			file_name: documentRow.file_name || '',
			processing_status: documentRow.processing_status || 'UNKNOWN'
		} : null;

		// 10. Build experience response section
		const isPublished = (experienceRow?.status || '').toUpperCase() === 'PUBLISHED';
		const safeGeneratedUrl = isPublished ? (experienceRow.generated_url || null) : null;
		const experienceSection = experienceRow ? {
			experience_id: getRowId(experienceRow) || experienceId,
			experience_title: experienceRow.experience_title || '',
			status: experienceRow.status || 'UNKNOWN',
			generated_url: isPublished ? safeGeneratedUrl : null,
			version_number: Number(experienceRow.version_number || 1),
			published_time: experienceRow.published_time || experienceRow.CREATEDTIME || null
		} : null;

		// 11. Structured Response Payload adhering to Salesperson Interface Boundary
		const responsePayload = {
			success: true,
			business_name: projectRow.business_name || '',
			project_name: projectRow.project_name || '',
			document_name: documentRow ? (documentRow.file_name || '') : '',
			current_status: currentStage,
			experience_title: experienceRow ? (experienceRow.experience_title || '') : '',
			generated_url: isPublished ? safeGeneratedUrl : null,
			published_time: experienceRow ? (experienceRow.published_time || experienceRow.CREATEDTIME || null) : null,
			error_message: errorMessage || null,
			project: projectSection,
			document: documentSection,
			experience: experienceSection,
			current_stage: currentStage,
			jobs: jobsList
		};

		// Clean logging (no content, credentials, or tokens)
		context.log(`spikra_process_status: project_id=${projectId}, document_id=${documentId}, experience_id=${experienceId}, jobs_count=${jobsList.length}, current_stage=${currentStage}, final_status=${projectSection.status}`);

		basicIO.setStatus(200);
		basicIO.write(JSON.stringify(responsePayload));
	} catch (error) {
		context.log('spikra_process_status error:', error.message);

		basicIO.setStatus(500);
		basicIO.write(
			JSON.stringify({
				success: false,
				message: 'Unable to retrieve processing status',
				error_message: error.message
			})
		);
	}

	context.close();
};

/**
 * Calculates current stage with FAILED taking priority if any active failure exists.
 */
function determineCurrentStage(projectRow, documentRow, experienceRow, jobRows) {
	// Active Failure Priority Check
	const expStatus = String(experienceRow?.status || '').toUpperCase();
	const docStatus = String(documentRow?.processing_status || '').toUpperCase();
	const projStatus = String(projectRow?.status || '').toUpperCase();
	const hasJobFailure = jobRows.some((job) => String(job.status || '').toUpperCase() === 'FAILED');

	if (expStatus === 'FAILED' || docStatus === 'FAILED' || projStatus === 'FAILED' || hasJobFailure) {
		return 'FAILED';
	}

	// Active Stage Priority
	if (expStatus === 'PUBLISHED') return 'PUBLISHED';
	if (expStatus === 'DEPLOYING') return 'DEPLOYING';
	if (expStatus === 'GENERATED') return 'GENERATED';
	if (expStatus === 'GENERATING') return 'GENERATING';

	if (docStatus === 'PROCESSING') return 'PROCESSING';
	if (docStatus === 'EXTRACTED') return 'EXTRACTED';
	if (docStatus === 'EXTRACTING') return 'EXTRACTING';
	if (docStatus === 'UPLOADED') return 'UPLOADED';

	return projStatus || 'UNKNOWN';
}

/**
 * Retrieves error message according to strict priority order:
 * 1. Experience error
 * 2. Document error
 * 3. Latest failed job error
 */
function getPrioritizedErrorMessage(experienceRow, documentRow, jobRows) {
	if (experienceRow && experienceRow.error_message) {
		return experienceRow.error_message;
	}
	if (documentRow && documentRow.error_message) {
		return documentRow.error_message;
	}
	const failedJob = jobRows.find(
		(job) => String(job.status || '').toUpperCase() === 'FAILED' && job.error_message
	);
	if (failedJob) {
		return failedJob.error_message;
	}
	return null;
}

/**
 * Extracts single row data from ZCQL query result.
 */
function getRowData(result, tableName) {
	if (!result) return null;
	if (Array.isArray(result) && result.length > 0) {
		const item = result[0];
		return item[tableName] || item;
	}
	return null;
}

/**
 * Extracts ROWID safely across Catalyst casing variations.
 */
function getRowId(row) {
	if (!row) return '';
	const target = row.PROJECTS || row.DOCUMENTS || row.EXPERIENCES || row.PROCESSING_JOBS || row;
	return String(target.ROWID || target.rowid || target.ROW_ID || target.id || '').trim();
}

/**
 * Escapes single quotes for ZCQL queries.
 */
function escapeValue(value) {
	return String(value || '').replace(/'/g, "''");
}