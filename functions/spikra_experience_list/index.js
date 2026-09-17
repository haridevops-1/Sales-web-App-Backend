'use strict';

const catalyst = require('zcatalyst-sdk-node');

const EXPERIENCES_TABLE = 'EXPERIENCES';
const PROJECTS_TABLE = 'PROJECTS';

/**
 * Basic I/O Entry Point for Function 7 (spikra_experience_list).
 * Retrieves generated customer experiences for valid active projects.
 * Verifies referential integrity against the PROJECTS table.
 * If projects have been deleted in Zoho Catalyst, automatically purges orphaned experience records.
 */
module.exports = async (context, basicIO) => {
	try {
		const app = catalyst.initialize(context);

		// 1. Read optional filters from basicIO arguments or raw body payload
		let projectId = basicIO.getArgument('project_id') || basicIO.getArgument('projectId') || null;
		let businessName = basicIO.getArgument('business_name') || basicIO.getArgument('businessName') || null;
		let status = basicIO.getArgument('status') || null;

		// Check if payload arrived as raw body (e.g. JSON POST)
		const bodyArg = basicIO.getArgument('req_body') || basicIO.getArgument('body') || basicIO.getArgument('BODY');
		if (bodyArg) {
			try {
				const parsedBody = typeof bodyArg === 'string' ? JSON.parse(bodyArg) : bodyArg;
				if (parsedBody && typeof parsedBody === 'object') {
					if (!projectId) projectId = parsedBody.project_id || parsedBody.projectId || null;
					if (!businessName) businessName = parsedBody.business_name || parsedBody.businessName || null;
					if (!status) status = parsedBody.status || null;
				}
			} catch (jsonErr) {
				context.log('spikra_experience_list invalid JSON body:', jsonErr.message);
				basicIO.setStatus(400);
				basicIO.write(
					JSON.stringify({
						success: false,
						message: 'Invalid request: malformed JSON payload',
						error_message: jsonErr.message,
						count: 0,
						experiences: []
					})
				);
				context.close();
				return;
			}
		}

		// 2. Validate parameter types if provided (return HTTP 400 on invalid format)
		if (projectId && typeof projectId !== 'string' && typeof projectId !== 'number') {
			basicIO.setStatus(400);
			basicIO.write(
				JSON.stringify({
					success: false,
					message: 'Invalid request: project_id must be a string or number',
					error_message: 'Invalid project_id parameter type',
					count: 0,
					experiences: []
				})
			);
			context.close();
			return;
		}

		if (businessName && typeof businessName !== 'string') {
			basicIO.setStatus(400);
			basicIO.write(
				JSON.stringify({
					success: false,
					message: 'Invalid request: business_name must be a string',
					error_message: 'Invalid business_name parameter type',
					count: 0,
					experiences: []
				})
			);
			context.close();
			return;
		}

		if (status && typeof status !== 'string') {
			basicIO.setStatus(400);
			basicIO.write(
				JSON.stringify({
					success: false,
					message: 'Invalid request: status must be a string',
					error_message: 'Invalid status parameter type',
					count: 0,
					experiences: []
				})
			);
			context.close();
			return;
		}

		const cleanProjectId = projectId ? String(projectId).trim() : null;
		const cleanBusinessName = businessName ? String(businessName).trim() : null;
		const cleanStatus = status ? String(status).trim() : null;

		// 3. Query active project IDs from PROJECTS table to maintain referential integrity
		let validProjectIds = new Set();
		try {
			const projectRows = await app.zcql().executeZCQLQuery(`SELECT ROWID FROM ${PROJECTS_TABLE}`);
			(projectRows || []).forEach((item) => {
				const proj = item[PROJECTS_TABLE] || item.projects || item;
				const id = String(proj.ROWID || proj.rowid || proj.ROW_ID || proj.id || '').trim();
				if (id) validProjectIds.add(id);
			});
		} catch (projErr) {
			context.log('spikra_experience_list project query warning:', projErr.message);
		}

		// 4. Build ZCQL Query for EXPERIENCES
		let query = `SELECT * FROM ${EXPERIENCES_TABLE}`;
		const conditions = [];

		if (cleanProjectId) {
			conditions.push(`project_id = '${escapeValue(cleanProjectId)}'`);
		}

		if (cleanBusinessName) {
			conditions.push(`business_name = '${escapeValue(cleanBusinessName)}'`);
		}

		if (cleanStatus) {
			conditions.push(`status = '${escapeValue(cleanStatus.toUpperCase())}'`);
		}

		if (conditions.length > 0) {
			query += ` WHERE ${conditions.join(' AND ')}`;
		}

		query += ` ORDER BY CREATEDTIME DESC`;

		context.log(`spikra_experience_list query: project_id=${cleanProjectId || 'all'}, business_name=${cleanBusinessName || 'all'}, status=${cleanStatus || 'all'}`);

		// 5. Execute Read-Only ZCQL Query
		const result = await app.zcql().executeZCQLQuery(query);

		// 6. Map and Normalize Experience Records, separating valid experiences from orphaned ones
		const orphanRowIds = [];
		const validExperiences = [];

		for (const item of (result || [])) {
			const exp = item.EXPERIENCES || item.experiences || item;

			const rowId = String(exp.ROWID || exp.rowid || exp.ROW_ID || exp.id || '').trim();
			const expProjectId = exp.project_id ? String(exp.project_id).trim() : null;

			// If project does not exist in PROJECTS table, mark as orphan to purge
			if (!expProjectId || !validProjectIds.has(expProjectId)) {
				if (rowId) {
					orphanRowIds.push(rowId);
				}
				continue;
			}

			const expStatus = exp.status ? String(exp.status).trim() : null;
			const genUrl = exp.generated_url ? String(exp.generated_url).trim() : null;

			let versionNum = 1;
			if (exp.version_number !== undefined && exp.version_number !== null && !isNaN(exp.version_number)) {
				versionNum = Number(exp.version_number);
			}

			validExperiences.push({
				experience_id: rowId || null,
				project_id: expProjectId,
				document_id: exp.document_id ? String(exp.document_id).trim() : null,
				business_name: exp.business_name ? String(exp.business_name).trim() : null,
				experience_title: exp.experience_title ? String(exp.experience_title).trim() : null,
				status: expStatus,
				generated_url: genUrl || null,
				version_number: versionNum,
				published_time: exp.published_time || null,
				created_time: exp.CREATEDTIME || exp.created_time || exp.createdtime || null,
				modified_time: exp.MODIFIEDTIME || exp.modified_time || exp.modifiedtime || null,
				error_message: exp.error_message || null
			});
		}

		// 7. Purge orphaned records from EXPERIENCES table in Catalyst Data Store
		if (orphanRowIds.length > 0) {
			try {
				const datastore = app.datastore();
				const expTable = datastore.table(EXPERIENCES_TABLE);
				// Delete in batches of 50
				for (let i = 0; i < orphanRowIds.length; i += 50) {
					const chunk = orphanRowIds.slice(i, i + 50);
					await expTable.deleteRows(chunk);
				}
				context.log(`spikra_experience_list: successfully purged ${orphanRowIds.length} orphaned experience records`);
			} catch (delErr) {
				context.log('spikra_experience_list orphan cleanup warning:', delErr.message);
			}
		}

		// 8. Construct Structured Response
		const response = {
			success: true,
			count: validExperiences.length,
			experiences: validExperiences
		};

		context.log(`spikra_experience_list: successfully retrieved ${validExperiences.length} valid experiences`);

		basicIO.setStatus(200);
		basicIO.write(JSON.stringify(response));
	} catch (error) {
		context.log('spikra_experience_list error:', error.message);

		basicIO.setStatus(500);
		basicIO.write(
			JSON.stringify({
				success: false,
				message: 'Unable to retrieve experiences',
				error_message: error.message,
				count: 0,
				experiences: []
			})
		);
	}

	context.close();
};

/**
 * Escapes single quotes for ZCQL queries to prevent SQL/ZCQL injection.
 */
function escapeValue(value) {
	return String(value || '').replace(/'/g, "''");
}
