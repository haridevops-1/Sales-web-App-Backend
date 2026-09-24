"use strict";

const catalyst = require("zcatalyst-sdk-node");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const GENERATED_BUCKET_NAME = "spikra-generated-experiences-698386704";

const PROJECTS_TABLE = "PROJECTS";
const DOCUMENTS_TABLE = "DOCUMENTS";
const EXPERIENCES_TABLE = "EXPERIENCES";
const PROCESSING_JOBS_TABLE = "PROCESSING_JOBS";

const {
	verifyAndBuildExperienceUrl,
	verifyUrlAccessible,
	generateBusinessSlug,
	SLATE_APP_URL,
	formatProposalUrl
} = require("./deploy_worker");

const REQUIRED_EXPERIENCE_FILES = [
	"index.html",
	"styles.css",
	"script.js",
	"experience.json"
];

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1 MB

module.exports = async (req, res) => {
	let app = null;
	let experienceId = "";
	let projectId = "";
	let documentId = "";
	let verifiedBusinessName = "";
	let deployJob = null;
	let deployJobId = "";

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}

		if (req.method === "GET") {
			app = catalyst.initialize(req);
			const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
			const queryExpId = String(urlObj.searchParams.get("experience_id") || urlObj.searchParams.get("id") || "").trim();
			const queryProjId = String(urlObj.searchParams.get("project_id") || "").trim();
			const queryDocId = String(urlObj.searchParams.get("document_id") || "").trim();
			let querySlug = String(urlObj.searchParams.get("slug") || "").trim();
			if (!querySlug) {
				const segments = urlObj.pathname.split("/").filter(Boolean);
				const lastSegment = segments[segments.length - 1];
				if (lastSegment && lastSegment !== "deploy" && !lastSegment.includes(".")) {
					querySlug = lastSegment;
				}
			}
			const requestedAsset = String(urlObj.searchParams.get("asset") || "").trim().toLowerCase();

			const datastore = app.datastore();
			const experiencesTable = datastore.table(EXPERIENCES_TABLE);

			let experienceRow = null;
			if (queryExpId) {
				experienceRow = await findRowById(app, experiencesTable, EXPERIENCES_TABLE, queryExpId, { document_id: queryDocId });
			} else if (queryDocId) {
				experienceRow = await findRowById(app, experiencesTable, EXPERIENCES_TABLE, null, { document_id: queryDocId });
			} else if (querySlug) {
				experienceRow = await findExperienceBySlug(app, querySlug);
			} else if (queryProjId) {
				try {
					const projQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE project_id = '${escapeQueryValue(queryProjId)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
					const projRes = await app.zcql().executeZCQLQuery(projQuery);
					if (Array.isArray(projRes) && projRes[0]) {
						experienceRow = projRes[0][EXPERIENCES_TABLE] || projRes[0];
					}
				} catch (e) {
					console.log("Project experience query notice:", e.message);
				}
			}

			if (!experienceRow) {
				if (requestedAsset === "json") {
					sendJson(res, 404, { success: false, message: "Experience record not found" });
				} else {
					sendNotFoundHtml(res, "This proposal experience could not be found. It may have been removed.");
				}
				return;
			}

			let experienceJson = null;
			const expId = getRowId(experienceRow);
			const projId = String(experienceRow.project_id || queryProjId || "").trim();
			let contentObjectKey = String(experienceRow.content_object_key || "").trim();
			if (!contentObjectKey && projId && expId) {
				contentObjectKey = `projects/${projId}/experiences/${expId}/version-1/`;
			}
			if (contentObjectKey && !contentObjectKey.endsWith("/")) contentObjectKey += "/";

			const genBucket = app.stratus().bucket(GENERATED_BUCKET_NAME);

			if (contentObjectKey) {
				try {
					const stream = await genBucket.getObject(`${contentObjectKey}experience.json`);
					const buf = await streamToBuffer(stream);
					experienceJson = JSON.parse(buf.toString("utf8"));
				} catch (e) {
					console.log("Could not load experience.json from Stratus:", e.message);
				}
			}

			if (requestedAsset === "logo") {
				const logoKey = String(
					experienceRow.generated_logo_object_key ||
					(contentObjectKey && experienceJson && experienceJson.branding && experienceJson.branding.logo_file
						? `${contentObjectKey}${experienceJson.branding.logo_file.replace(/^assets\//, "assets/")}`
						: "")
				).trim();

				if (!logoKey) {
					sendJson(res, 404, { success: false, message: "Business logo not found" });
					return;
				}

				try {
					const logoStream = await genBucket.getObject(logoKey);
					const logoBuffer = await streamToBuffer(logoStream);
					res.statusCode = 200;
					res.setHeader("Content-Type", getContentTypeByKey(logoKey));
					res.setHeader("Cache-Control", "public, max-age=3600");
					res.end(logoBuffer);
				} catch (logoError) {
					console.log("Could not load business logo:", logoError.message);
					sendJson(res, 404, { success: false, message: "Business logo not found" });
				}
				return;
			}

			// Proxies Function 4's generated per-experience styles.css/script.js through this GET route
			// so the customer-facing link shows the real business content, not a static placeholder.
			if (requestedAsset === "styles.css" || requestedAsset === "script.js") {
				if (!contentObjectKey) {
					sendJson(res, 404, { success: false, message: "Experience content was not found" });
					return;
				}
				try {
					const assetStream = await genBucket.getObject(`${contentObjectKey}${requestedAsset}`);
					const assetBuffer = await streamToBuffer(assetStream);
					res.statusCode = 200;
					res.setHeader(
						"Content-Type",
						requestedAsset === "styles.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8"
					);
					res.setHeader("Cache-Control", "public, max-age=300");
					if (requestedAsset === "styles.css") {
						let cssText = assetBuffer.toString("utf8");
						cssText = cssText.replace(/'Space Grotesk'/g, "'Poppins'");
						cssText += `\n.kpi.accent .k-value { color: var(--deep) !important; }\n.client-logo img { height: 96px !important; max-height: 104px !important; max-width: 160px !important; }\n.acc-item.open .acc-body { max-height: 600px !important; opacity: 1 !important; }`;
						res.end(Buffer.from(cssText, "utf8"));
					} else if (requestedAsset === "script.js") {
						const rawScript = assetBuffer.toString("utf8");
						const safeScript = `(function(){\ntry {\n${rawScript}\n} catch(err) { console.warn("Proposal script warning:", err); }\n})();`;
						res.end(Buffer.from(safeScript, "utf8"));
					} else {
						res.end(assetBuffer);
					}
				} catch (assetError) {
					console.log(`Could not load ${requestedAsset} from Stratus:`, assetError.message);
					sendJson(res, 404, { success: false, message: `Experience ${requestedAsset} was not found` });
				}
				return;
			}

			if (requestedAsset === "json") {
				const hasLogo = Boolean(
					experienceRow.business_logo_object_key ||
					experienceRow.generated_logo_object_key ||
					(experienceJson && experienceJson.branding && experienceJson.branding.logo_available)
				);

				sendJson(res, 200, {
					success: true,
					experience_id: expId,
					project_id: projId,
					business_name: experienceRow.business_name || (experienceJson && experienceJson.business_name) || "Customer Partner",
					title: experienceRow.experience_title || (experienceJson && experienceJson.title) || "Customer Proposal Experience",
					status: experienceRow.status,
					generated_url: (experienceRow.status === "PUBLISHED" && experienceRow.generated_url && isValidHttpUrl(experienceRow.generated_url))
						? (typeof formatProposalUrl === "function" ? formatProposalUrl(experienceRow.generated_url, expId, projId) : experienceRow.generated_url)
						: null,
					business_logo: {
						available: hasLogo,
						file: hasLogo
							? `/spikra/experience/deploy?experience_id=${encodeURIComponent(expId)}&project_id=${encodeURIComponent(projId)}&asset=logo`
							: null,
						object_key: experienceRow.generated_logo_object_key || experienceRow.business_logo_object_key || null
					},
					experience: experienceJson
				});
				return;
			}

			if (!contentObjectKey) {
				sendNotFoundHtml(res, "This proposal experience has not finished generating yet.");
				return;
			}

			try {
				const htmlStream = await genBucket.getObject(`${contentObjectKey}index.html`);
				const htmlBuffer = await streamToBuffer(htmlStream);
				const rewrittenHtml = rewriteGeneratedAssetLinks(htmlBuffer.toString("utf8"), expId, projId, querySlug);

				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.setHeader("Cache-Control", "no-store");
				res.end(rewrittenHtml);
			} catch (htmlError) {
				console.log("Could not load index.html from Stratus:", htmlError.message);
				sendNotFoundHtml(res, "This proposal experience could not be loaded right now.");
			}
			return;
		}

		if (req.method !== "POST") {
			sendJson(res, 405, {
				success: false,
				message: "Only POST and GET requests are supported."
			});
			return;
		}

		const rawBody = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
		const requestData = parseJsonBody(rawBody);

		let rawExperienceId =
			requestData.experience_id ||
			requestData.experienceId ||
			requestData.id;
		let rawProjectId =
			requestData.project_id ||
			requestData.projectId;
		let rawDocumentId =
			requestData.document_id ||
			requestData.documentId;
		let requestBusinessName =
			requestData.business_name ||
			requestData.businessName;

		experienceId = String(rawExperienceId || "").trim();
		projectId = String(rawProjectId || "").trim();
		documentId = String(rawDocumentId || "").trim();
		requestBusinessName = String(requestBusinessName || "").trim();

		if (!experienceId) {
			throw new ValidationError("experience_id is required.");
		}

		app = catalyst.initialize(req);
		const datastore = app.datastore();
		const stratus = app.stratus();

		const experiencesTable = datastore.table(EXPERIENCES_TABLE);
		const projectsTable = datastore.table(PROJECTS_TABLE);
		const documentsTable = datastore.table(DOCUMENTS_TABLE);
		const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);

		const experienceRow = await findRowById(app, experiencesTable, EXPERIENCES_TABLE, experienceId, { document_id: documentId });
		if (!experienceRow) {
			throw new NotFoundError(`Experience record was not found for experience_id: ${experienceId}`);
		}

		const expProjectId = String(experienceRow.project_id || "").trim();
		const expDocumentId = String(experienceRow.document_id || "").trim();

		if (projectId && expProjectId && projectId !== expProjectId) {
			throw new ValidationError("The provided project_id does not match the experience record.");
		}
		if (!projectId) {
			projectId = expProjectId;
		}
		if (!projectId) {
			throw new ValidationError("project_id could not be resolved from request or experience record.");
		}

		if (documentId && expDocumentId && documentId !== expDocumentId) {
			throw new ValidationError("The provided document_id does not match the experience record.");
		}
		if (!documentId) {
			documentId = expDocumentId;
		}
		if (!documentId) {
			throw new ValidationError("document_id could not be resolved from request or experience record.");
		}

		const projectRow = await findRowById(app, projectsTable, PROJECTS_TABLE, projectId);
		if (!projectRow) {
			throw new NotFoundError(`Project record was not found for project_id: ${projectId}`);
		}

		verifiedBusinessName = String(projectRow.business_name || "").trim();
		if (!verifiedBusinessName) {
			if (requestBusinessName) {
				verifiedBusinessName = requestBusinessName;
			} else if (experienceRow.business_name) {
				verifiedBusinessName = String(experienceRow.business_name).trim();
			}
		}

		if (!verifiedBusinessName) {
			throw new ValidationError("business_name is missing from the project record.");
		}

		const documentRow = await findRowById(app, documentsTable, DOCUMENTS_TABLE, documentId);
		if (!documentRow) {
			throw new NotFoundError(`Document record was not found for document_id: ${documentId}`);
		}

		const docProjectId = String(documentRow.project_id || "").trim();
		if (docProjectId && docProjectId !== projectId) {
			throw new ValidationError("Document does not belong to the specified project.");
		}

		const currentStatus = String(experienceRow.status || "").trim().toUpperCase();
		const rawExistingGeneratedUrl = String(experienceRow.generated_url || "").trim();
		const existingGeneratedUrl = (typeof formatProposalUrl === "function" && rawExistingGeneratedUrl)
			? formatProposalUrl(rawExistingGeneratedUrl, experienceId, projectId)
			: rawExistingGeneratedUrl;

		const friendlySlugMatch = existingGeneratedUrl ? existingGeneratedUrl.match(/[?&]slug=([^&]+)/) : null;
		const isFriendlyUrl = existingGeneratedUrl &&
			existingGeneratedUrl.includes("spikra-ai-proposal.onslate.com") &&
			Boolean(friendlySlugMatch) &&
			decodeURIComponent(friendlySlugMatch[1]).endsWith("_proposal");

		if (currentStatus === "PUBLISHED" && existingGeneratedUrl && isValidHttpUrl(existingGeneratedUrl) && isFriendlyUrl) {
			const isLive = await verifyUrlAccessible(existingGeneratedUrl);
			if (isLive) {
				if (rawExistingGeneratedUrl !== existingGeneratedUrl) {
					try {
						await experiencesTable.updateRow({
							ROWID: experienceId,
							generated_url: existingGeneratedUrl
						}).catch(() => {});
					} catch {}
				}
				console.log(`Idempotent hit: Experience ${experienceId} is already PUBLISHED with verified friendly live URL ${existingGeneratedUrl}`);
				sendJson(res, 200, {
					success: true,
					message: "Customer experience published successfully",
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					business_name: verifiedBusinessName,
					status: "PUBLISHED",
					generated_url: existingGeneratedUrl
				});
				return;
			}
			console.log(`Experience ${experienceId} was PUBLISHED but stored URL (${existingGeneratedUrl}) is not accessible. Republishing.`);
		}

		if (currentStatus === "DEPLOYING") {
			console.log(`Deployment already in progress for experience ${experienceId}`);
			sendJson(res, 200, {
				success: true,
				message: "Experience deployment is already in progress",
				project_id: projectId,
				document_id: documentId,
				experience_id: experienceId,
				business_name: verifiedBusinessName,
				status: "DEPLOYING"
			});
			return;
		}

		if (currentStatus !== "GENERATED" && currentStatus !== "FAILED" && currentStatus !== "PUBLISHED") {
			throw new ValidationError(
				`Experience status must be GENERATED or FAILED to initiate deployment. Current status: ${currentStatus || "UNKNOWN"}`
			);
		}

		let contentObjectKey = String(experienceRow.content_object_key || "").trim();
		if (!contentObjectKey) {
			contentObjectKey = `projects/${projectId}/experiences/${experienceId}/version-1/`;
		}
		if (!contentObjectKey.endsWith("/")) {
			contentObjectKey += "/";
		}

		console.log(`Verifying generated files in Stratus bucket ${GENERATED_BUCKET_NAME}: ${contentObjectKey}`);
		const genBucket = stratus.bucket(GENERATED_BUCKET_NAME);

		for (const requiredFileName of REQUIRED_EXPERIENCE_FILES) {
			const fileKey = `${contentObjectKey}${requiredFileName}`;
			let fileStream;
			try {
				fileStream = await genBucket.getObject(fileKey);
			} catch (bucketErr) {
				console.error(`Missing required file in Stratus: ${fileKey} (${bucketErr.message})`);
				throw new ProcessingError(`Required file '${requiredFileName}' does not exist in Stratus bucket.`);
			}

			const fileBuffer = await streamToBuffer(fileStream);
			if (!fileBuffer || fileBuffer.length === 0) {
				throw new ProcessingError(`Required file '${requiredFileName}' is empty in Stratus bucket.`);
			}
		}

		if (experienceRow.generated_logo_object_key) {
			try {
				const logoStream = await genBucket.getObject(experienceRow.generated_logo_object_key);
				const logoBuffer = await streamToBuffer(logoStream);
				if (logoBuffer && logoBuffer.length > 0) {
					console.log(`Verified generated logo asset in Stratus: ${experienceRow.generated_logo_object_key}`);
				}
			} catch (logoErr) {
				console.log("Notice: Logo asset verification:", logoErr.message);
			}
		}

		console.log(`All required files verified in Stratus for experience ${experienceId}.`);

		deployJob = await findProcessingJob(app, documentId, "DEPLOY");
		if (deployJob) {
			deployJobId = getRowId(deployJob);
			try {
				await processingJobsTable.updateRow({
					ROWID: deployJobId,
					experience_id: experienceId,
					status: "RUNNING",
					attempt_count: Number(deployJob.attempt_count || 0) + 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				console.log(`DEPLOY job ${deployJobId} updated to RUNNING`);
			} catch (jobUpdateErr) {
				console.log("Notice: Failed to update existing DEPLOY job:", jobUpdateErr.message);
			}
		} else {
			try {
				deployJob = await processingJobsTable.insertRow({
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					job_type: "DEPLOY",
					status: "RUNNING",
					attempt_count: 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				deployJobId = getRowId(deployJob);
				console.log(`Created new DEPLOY job: ${deployJobId}`);
			} catch (jobInsertErr) {
				console.log("Notice: Failed to insert new DEPLOY job:", jobInsertErr.message);
			}
		}

		await experiencesTable.updateRow({
			ROWID: experienceId,
			status: "DEPLOYING",
			error_message: ""
		});
		console.log(`EXPERIENCES record ${experienceId} updated to DEPLOYING`);

		const projectName = String(projectRow.project_name || experienceRow.experience_title || "").trim();
		const nowFormatted = new Date().toISOString().replace("T", " ").substring(0, 19);

		const deployResult = await verifyAndBuildExperienceUrl({
			app,
			projectId,
			experienceId,
			businessName: verifiedBusinessName
		});
		const finalUrl = (typeof formatProposalUrl === "function" ? formatProposalUrl(deployResult.generated_url, experienceId, projectId) : null) || deployResult.generated_url;

		await experiencesTable.updateRow({
			ROWID: experienceId,
			status: "PUBLISHED",
			generated_url: finalUrl,
			published_time: nowFormatted,
			error_message: ""
		});

		await projectsTable.updateRow({
			ROWID: projectId,
			status: "PUBLISHED",
			generated_url: finalUrl
		}).catch(() => {});

		if (deployJobId) {
			await processingJobsTable.updateRow({
				ROWID: deployJobId,
				status: "COMPLETED",
				completed_time: nowFormatted,
				error_message: ""
			}).catch(() => {});
		}

		sendJson(res, 200, {
			success: true,
			message: "Customer experience published successfully",
			business_name: verifiedBusinessName,
			project_name: projectName,
			document_name: documentRow.file_name || "",
			status: "PUBLISHED",
			experience_title: experienceRow.experience_title || `${verifiedBusinessName} - ${projectName}`,
			generated_url: finalUrl,
			published_time: nowFormatted
		});
		return;
	} catch (error) {
		console.error("spikra_experience_deploy caught error:", error.message);

		const userErrorMessage = getSafeErrorMessage(error);

		if (app) {
			if (experienceId) {
				try {
					const experiencesTable = app.datastore().table(EXPERIENCES_TABLE);
					await experiencesTable.updateRow({
						ROWID: experienceId,
						status: "FAILED",
						generated_url: "",
						error_message: userErrorMessage
					});
				} catch (expErr) {
					console.error("Failed to mark EXPERIENCES as FAILED:", expErr.message);
				}
			}

			if (projectId) {
				try {
					const projectsTable = app.datastore().table(PROJECTS_TABLE);
					await projectsTable.updateRow({
						ROWID: projectId,
						status: "FAILED"
					});
				} catch (projErr) {
					console.log("Notice: Failed to mark PROJECTS as FAILED:", projErr.message);
				}
			}

			if (deployJobId) {
				try {
					const processingJobsTable = app.datastore().table(PROCESSING_JOBS_TABLE);
					await processingJobsTable.updateRow({
						ROWID: deployJobId,
						status: "FAILED",
						completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
						error_message: userErrorMessage
					});
				} catch (jobErr) {
					console.error("Failed to mark PROCESSING_JOBS as FAILED:", jobErr.message);
				}
			}
		}

		sendJson(res, 200, {
			success: false,
			message: "Customer experience deployment failed",
			project_id: projectId || "",
			document_id: documentId || "",
			experience_id: experienceId || "",
			business_name: verifiedBusinessName || "",
			status: "FAILED",
			generated_url: null,
			error: userErrorMessage
		});
	}
};

function isValidHttpUrl(string) {
	try {
		const url = new URL(string);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

async function findRowById(app, table, tableName, rowId, fallbackFilter) {
	if (!rowId && !fallbackFilter) return null;
	const diagnostics = [];

	if (rowId) {
		try {
			const row = await table.getRow(rowId);
			if (row) {
				return row[tableName] || row;
			}
		} catch (err) {
			diagnostics.push(`getRow(${rowId}): ${err.message}`);
		}
	}

	if (app && typeof app.zcql === "function") {
		if (rowId) {
			const cleanId = String(rowId).replace(/[^0-9]/g, "");
			if (cleanId) {
				try {
					const query = `SELECT * FROM ${tableName} WHERE ROWID = ${cleanId} LIMIT 1`;
					const result = await app.zcql().executeZCQLQuery(query);
					const row = Array.isArray(result) && result[0] ? result[0] : null;
					if (row) {
						return row[tableName] || row;
					}
				} catch (zcqlNumErr) {
					diagnostics.push(`zcql num: ${zcqlNumErr.message}`);
				}
			}

			try {
				const queryStr = `SELECT * FROM ${tableName} WHERE ROWID = '${escapeQueryValue(rowId)}' LIMIT 1`;
				const resultStr = await app.zcql().executeZCQLQuery(queryStr);
				const rowStr = Array.isArray(resultStr) && resultStr[0] ? resultStr[0] : null;
				if (rowStr) {
					return rowStr[tableName] || rowStr;
				}
			} catch (zcqlStrErr) {
				diagnostics.push(`zcql str: ${zcqlStrErr.message}`);
			}
		}

		if (fallbackFilter && fallbackFilter.document_id) {
			try {
				const docQuery = `SELECT * FROM ${tableName} WHERE document_id = '${escapeQueryValue(fallbackFilter.document_id)}' ORDER BY CREATEDTIME DESC LIMIT 1`;
				const docResult = await app.zcql().executeZCQLQuery(docQuery);
				const docRow = Array.isArray(docResult) && docResult[0] ? docResult[0] : null;
				if (docRow) {
					console.log(`Resolved row in ${tableName} via document_id fallback.`);
					return docRow[tableName] || docRow;
				}
			} catch (docErr) {
				diagnostics.push(`zcql doc fallback: ${docErr.message}`);
			}
		}
	}

	console.log(`findRowById on ${tableName} failed. Diagnostics: ${diagnostics.join(" | ")}`);
	return null;
}

async function findProcessingJob(app, documentId, jobType) {
	if (!app || typeof app.zcql !== "function" || !documentId) return null;

	const query = `
		SELECT *
		FROM ${PROCESSING_JOBS_TABLE}
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
			return row[PROCESSING_JOBS_TABLE] || row;
		}
	} catch (e) {
		console.log("findProcessingJob ZCQL notice:", e.message);
		return null;
	}

	return null;
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

function streamToBuffer(stream) {
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

function getRowId(row) {
	if (!row) return "";
	const target = row.EXPERIENCES || row.PROCESSING_JOBS || row.DOCUMENTS || row.PROJECTS || row;
	return String(target.ROWID || target.rowid || target.ROW_ID || target.id || "").trim();
}

function escapeQueryValue(value) {
	return String(value || "")
		.replace(/'/g, "''")
		.replace(/\\/g, "\\\\");
}

// Catalyst's own CORS allowlist already injects Access-Control-Allow-Origin for
// spikra-ai-proposal-app.onslate.com (confirmed live on Function 3 - setting our own value on top of
// that produced "header contains multiple values" and the browser rejected the response outright).
// The public Slate proposal page (spikra-ai-proposal.onslate.com) and local dev aren't in that
// allowlist, so this endpoint - fetched from both - still needs to set its own header for them.
const CATALYST_COVERED_ORIGIN = "https://spikra-ai-proposal-app.onslate.com";

function setCorsHeaders(req, res) {
	const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || "";
	if (origin !== CATALYST_COVERED_ORIGIN) {
		res.setHeader("Access-Control-Allow-Origin", origin || "*");
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
	res.setHeader("Access-Control-Max-Age", "86400");
}

function getContentTypeByKey(key) {
	const extension = String(key || "").toLowerCase().split(".").pop();
	const contentTypes = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
		svg: "image/svg+xml"
	};
	return contentTypes[extension] || "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

function sendNotFoundHtml(res, message) {
	res.statusCode = 404;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Not Found | Spikra</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f2b3c;text-align:center;padding:24px}
  h1{font-size:1.5rem;margin-bottom:8px}
  p{color:#64748b;max-width:420px}
</style></head>
<body><div><h1>Proposal not available</h1><p>${escapeHtmlText(message || "This link is no longer valid.")}</p></div></body></html>`);
}

function escapeHtmlText(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const DEPLOY_BASE_URL = "https://spikra-ai-proposal-698386704.development.catalystserverless.com/spikra/experience/deploy";

function rewriteGeneratedAssetLinks(html, expId, projId, slug) {
	let baseQs = `experience_id=${encodeURIComponent(expId)}&project_id=${encodeURIComponent(projId)}`;
	if (slug) {
		baseQs = `slug=${encodeURIComponent(slug)}&` + baseQs;
	}
	const logoUrl = `${DEPLOY_BASE_URL}?${baseQs}&asset=logo`;
	const cssUrl = `${DEPLOY_BASE_URL}?${baseQs}&asset=styles.css`;
	const jsUrl = `${DEPLOY_BASE_URL}?${baseQs}&asset=script.js`;
	const googleFontsLink = '<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';

	let out = String(html || "")
		.replace(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']*Space\+Grotesk[^"']*/gi, 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap')
		.replace(/\$1\s*(<link rel="stylesheet")/gi, `${googleFontsLink}\n$1`)
		.replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\s*\$1/gi, `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n${googleFontsLink}`)
		.replace(/^\s*\$1\s*$/gm, "")
		.replace(/>\s*\$1\s*</g, "><")
		.replace(/href=["']styles\.css["']/g, `href="${cssUrl}"`)
		.replace(/src=["']script\.js["']/g, `src="${jsUrl}"`)
		.replace(/src=["']assets\/business-logo\.[a-zA-Z0-9]+["']/gi, `src="${logoUrl}"`)
		.replace(/src=["']assets\/[^"']*logo[^"']*["']/gi, `src="${logoUrl}"`);

	// Transform legacy client logo box with internal <h3> into client-badge with separate client-name
	out = out.replace(
		/<div class="client-logo">\s*<img([^>]*)>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/div>/gi,
		'<div class="client-badge"><div class="client-logo"><img$1></div><div class="client-name">$2</div></div>'
	);
	out = out.replace(
		/<div class="client-logo">\s*(<div class="client-logo-fallback"[\s\S]*?<\/div>)\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/div>/gi,
		'<div class="client-badge"><div class="client-logo">$1</div><div class="client-name">$2</div></div>'
	);

	// Ensure uniform KPI card color (remove accent from deliverables cards)
	out = out.replace(/(<section[^>]*id="deliverables"[\s\S]*?<\/section>)/i, (match) => {
		return match.replace(/\bclass="kpi\s+accent"/gi, 'class="kpi"');
	});

	// Inject runtime modern styling and accordion fix
	const runtimeStyles = `<style id="spikra-modern-runtime-patch">
  h1, h2, h3, .eyebrow, .kpi .k-value, .acc-title, .plabel, .tab, .mgroup, .tl-detail h3, .org-head .oh-title, .p-name, .cta-box h2, .client-name {
    font-family: 'Poppins', sans-serif !important;
  }
  body, p, .k-label, .k-note, .hero-sub, .mcell p, .acc-body p, .acc-tease, .check li, .tl-name, .tl-wk, .tl-detail li, .tl-note, .lead-pill {
    font-family: 'Inter', sans-serif !important;
  }
  .client-badge {
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 10px !important;
    flex-shrink: 0 !important;
  }
  .client-logo {
    min-width: 140px !important;
    min-height: 100px !important;
    padding: 16px 22px !important;
    border-radius: 16px !important;
  }
  .client-logo img {
    height: 96px !important;
    max-height: 104px !important;
    width: auto !important;
    max-width: 160px !important;
    object-fit: contain !important;
  }
  .client-name {
    font-family: 'Poppins', sans-serif !important;
    font-size: 13.5px !important;
    font-weight: 600 !important;
    color: var(--deep) !important;
    text-align: center !important;
    letter-spacing: -0.01em !important;
  }
  .kpi.accent .k-value {
    color: var(--deep) !important;
  }
  .acc-item, .acc-bar {
    cursor: pointer !important;
  }
  .acc-item.open .acc-body {
    max-height: 600px !important;
    opacity: 1 !important;
  }
</style>`;

	// No runtime accordion script here anymore: script.js (extracted from the master template)
	// already binds one delegated click handler to #acc. A second handler was previously added
	// here as well - both fired on every click and each re-read classList.contains('open') after
	// the other had already toggled it, so they canceled each other out (a click to open or close
	// a row visually did nothing). Function 4 already guarantees a non-empty description server
	// side, so the empty-description fallback that lived alongside that duplicate handler is
	// removed too - there is nothing left here for it to patch.
	const runtimeScript = "";

	if (out.includes("</head>")) {
		out = out.replace("</head>", `${runtimeStyles}\n</head>`);
	} else {
		out = `${runtimeStyles}\n${out}`;
	}

	if (out.includes("</body>")) {
		out = out.replace("</body>", `${runtimeScript}\n</body>`);
	} else {
		out += `\n${runtimeScript}`;
	}

	return out;
}

async function findExperienceBySlug(app, slug) {
	if (!slug) return null;
	const cleanSlug = String(slug).replace(/^\/+|\/+$/g, "").toLowerCase().trim();
	if (!cleanSlug || cleanSlug === "index.html") return null;

	const targetUrls = [
		`https://spikra-ai-proposal.onslate.com/?slug=${cleanSlug}`,
		`https://spikra-ai-proposal.onslate.com/${cleanSlug}`,
		`https://spikra-ai-proposal.onslate.com/${cleanSlug}/`,
		`https://spikra-experience-kspwbmax.onslate.com/?slug=${cleanSlug}`,
		`https://spikra-experience-kspwbmax.onslate.com/${cleanSlug}`,
		`https://spikra-experience-kspwbmax.onslate.com/${cleanSlug}/`
	];

	for (const targetUrl of targetUrls) {
		try {
			const query = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE generated_url = '${escapeQueryValue(targetUrl)}' LIMIT 1`;
			const res = await app.zcql().executeZCQLQuery(query);
			if (Array.isArray(res) && res[0]) {
				return res[0][EXPERIENCES_TABLE] || res[0];
			}
		} catch (e) {
			console.log("findExperienceBySlug exact url query notice:", e.message);
		}
	}

	try {
		const recentQuery = `SELECT * FROM ${EXPERIENCES_TABLE} ORDER BY CREATEDTIME DESC LIMIT 35`;
		const recentRes = await app.zcql().executeZCQLQuery(recentQuery);
		if (Array.isArray(recentRes)) {
			for (const item of recentRes) {
				const row = item[EXPERIENCES_TABLE] || item;
				const genUrl = String(row.generated_url || "").toLowerCase();
				if (genUrl.includes(cleanSlug)) {
					return row;
				}
			}
		}
	} catch (e) {
		console.log("findExperienceBySlug recent query notice:", e.message);
	}

	for (const targetUrl of targetUrls) {
		try {
			const projQuery = `SELECT * FROM ${PROJECTS_TABLE} WHERE generated_url = '${escapeQueryValue(targetUrl)}' LIMIT 1`;
			const projRes = await app.zcql().executeZCQLQuery(projQuery);
			if (Array.isArray(projRes) && projRes[0]) {
				const projectRow = projRes[0][PROJECTS_TABLE] || projRes[0];
				const pId = getRowId(projectRow);
				if (pId) {
					const expQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE project_id = '${escapeQueryValue(pId)}' LIMIT 1`;
					const expRes = await app.zcql().executeZCQLQuery(expQuery);
					if (Array.isArray(expRes) && expRes[0]) {
						return expRes[0][EXPERIENCES_TABLE] || expRes[0];
					}
				}
			}
		} catch (e) {
			console.log("findExperienceBySlug project url query notice:", e.message);
		}
	}

	const stripped = cleanSlug.replace(/_proposal$/i, "").trim();
	const nameCandidates = [
		stripped.replace(/-/g, " "),
		stripped.replace(/26/g, "&").replace(/-/g, " "),
		stripped.replace(/-/g, "%26"),
		stripped
	].filter(Boolean);

	for (const candidate of nameCandidates) {
		try {
			const bizQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE business_name = '${escapeQueryValue(candidate)}' LIMIT 1`;
			const bizRes = await app.zcql().executeZCQLQuery(bizQuery);
			if (Array.isArray(bizRes) && bizRes[0]) {
				return bizRes[0][EXPERIENCES_TABLE] || bizRes[0];
			}
		} catch (e) {
			console.log("findExperienceBySlug business_name query notice:", e.message);
		}

		try {
			const projBizQuery = `SELECT * FROM ${PROJECTS_TABLE} WHERE business_name = '${escapeQueryValue(candidate)}' LIMIT 1`;
			const projBizRes = await app.zcql().executeZCQLQuery(projBizQuery);
			if (Array.isArray(projBizRes) && projBizRes[0]) {
				const projectRow = projBizRes[0][PROJECTS_TABLE] || projBizRes[0];
				const pId = getRowId(projectRow);
				if (pId) {
					const expQuery = `SELECT * FROM ${EXPERIENCES_TABLE} WHERE project_id = '${escapeQueryValue(pId)}' LIMIT 1`;
					const expRes = await app.zcql().executeZCQLQuery(expQuery);
					if (Array.isArray(expRes) && expRes[0]) {
						return expRes[0][EXPERIENCES_TABLE] || expRes[0];
					}
				}
			}
		} catch (e) {
			console.log("findExperienceBySlug project business_name query notice:", e.message);
		}
	}

	return null;
}

function getSafeErrorMessage(error) {
	if (
		error instanceof ValidationError ||
		error instanceof NotFoundError ||
		error instanceof ProcessingError
	) {
		return error.message;
	}
	return "Customer experience deployment failed due to an unexpected system error.";
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
