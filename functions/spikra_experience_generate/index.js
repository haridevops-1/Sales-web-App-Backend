"use strict";

const catalyst = require("zcatalyst-sdk-node");
const fs = require("fs");
const path = require("path");

let getDocument;
let getProject;
let findProcessingJob;
let findExperience;
let getRowId;
let streamToBuffer;
let escapeHtml;
let sanitizeErrorMessage;

try {
	const datastoreModule = require("./shared/datastore/targetedQueries");
	getDocument = datastoreModule.getDocument;
	getProject = datastoreModule.getProject;
	findProcessingJob = datastoreModule.findProcessingJob;
	findExperience = datastoreModule.findExperience;
	getRowId = datastoreModule.getRowId;
	const utilsModule = require("./shared/utils");
	streamToBuffer = utilsModule.streamToBuffer;
	escapeHtml = utilsModule.escapeHtml;
	sanitizeErrorMessage = utilsModule.sanitizeErrorMessage;
} catch {
	const datastoreModule = require("../../shared/datastore/targetedQueries");
	getDocument = datastoreModule.getDocument;
	getProject = datastoreModule.getProject;
	findProcessingJob = datastoreModule.findProcessingJob;
	findExperience = datastoreModule.findExperience;
	getRowId = datastoreModule.getRowId;
	const utilsModule = require("../../shared/utils");
	streamToBuffer = utilsModule.streamToBuffer;
	escapeHtml = utilsModule.escapeHtml;
	sanitizeErrorMessage = utilsModule.sanitizeErrorMessage;
}

const PROCESS_BUCKET_NAME = "spikra-process-documents-698386704";
const GENERATED_BUCKET_NAME = "spikra-generated-experiences-698386704";

const PROJECTS_TABLE = "PROJECTS";
const DOCUMENTS_TABLE = "DOCUMENTS";
const EXPERIENCES_TABLE = "EXPERIENCES";
const PROCESSING_JOBS_TABLE = "PROCESSING_JOBS";

const MAX_DOCUMENT_TEXT_SIZE = 15 * 1024 * 1024; // 15 MB
const MAX_ANALYSIS_SIZE = 10 * 1024 * 1024; // 10 MB

const CURATED_CAPABILITY_SVGS = [
	'<svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 3V5Z"/><path d="M8 9h8M8 12h5"/></svg>',
	'<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="3.1"/><path d="M4.5 20a5.5 5.5 0 0 1 11 0"/><path d="M19 7v6M16 10h6"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M4 10v4a1 1 0 0 0 1 1h2l4 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M15 8a4 4 0 0 1 0 8"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/></svg>',
	'<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="5"/><path d="M9 13.5 7.5 21 12 18.5 16.5 21 15 13.5"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
];

const EXPERIENCE_CONTENT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"proposal_title",
		"project_summary",
		"what_we_deliver",
		"spikra_way",
		"how_we_support",
		"deliverable_cards",
		"customer_benefits",
		"capabilities",
		"timeline_phases",
		"rollout_overview",
		"de_risk_summary"
	],
	properties: {
		proposal_title: {
			type: "string",
			description: "Short, professional proposal title, e.g. 'Zoho CRM & Marketing Automation'"
		},
		project_summary: {
			type: "string",
			description: "2-3 concise customer-friendly sentences explaining what Spikra is proposing, platforms involved, and operational outcomes."
		},
		what_we_deliver: {
			type: "string",
			description: "1-2 concise sentences on what Spikra delivers (configured platform engagement layer and core workflows)."
		},
		spikra_way: {
			type: "string",
			description: "1-2 concise sentences on Spikra's BRD-aligned delivery approach with explicit assumptions and discovery workshop."
		},
		how_we_support: {
			type: "string",
			description: "1-2 concise sentences on support approach, integration decisions, user onboarding, and dedicated Hypercare."
		},
		deliverable_cards: {
			type: "array",
			description: "Exactly 6 concise deliverable cards summarizing platform, scope, phases, core workflows, and outputs.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "value", "note"],
				properties: {
					label: { type: "string", description: "Short category label, e.g. 'Platform', 'Scope', 'Phase 1', 'Workflow', 'Ecosystem', 'Loyalty / Output'" },
					value: { type: "string", description: "Short title or value (1-4 words)" },
					note: { type: "string", description: "ONE concise explanatory sentence (10-18 words). Avoid long paragraphs." }
				}
			}
		},
		customer_benefits: {
			type: "array",
			description: "6 to 8 concise, outcome-oriented customer benefits explaining what the business gets from the solution. Active voice, easy to scan.",
			items: { type: "string" }
		},
		capabilities: {
			type: "array",
			description: "5 to 8 important capabilities from the source document.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title", "subtitle", "teaser", "description"],
				properties: {
					title: { type: "string", description: "Concise capability title (2-5 words)" },
					subtitle: { type: "string", description: "Short subtitle (2-6 words)" },
					teaser: { type: "string", description: "Short teaser (3-7 words)" },
					description: { type: "string", description: "1-2 concise sentences explaining the value in simple everyday business language." }
				}
			}
		},
		timeline_phases: {
			type: "array",
			description: "3 to 4 implementation stages/phases based on source material.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "duration", "items"],
				properties: {
					name: { type: "string", description: "Stage name, e.g. 'Discovery Workshop', 'Phase 1 — Core Build'" },
					duration: { type: "string", description: "Estimated duration, e.g. '2–3 weeks', '4–6 weeks'" },
					items: {
						type: "array",
						description: "2 to 4 concise bullet activities for this stage.",
						items: { type: "string" }
					},
					note: { type: "string", description: "Optional short 1-sentence note or milestone." }
				}
			}
		},
		rollout_overview: {
			type: "array",
			description: "Exactly 2 cards summarizing rollout focus (Phase 1 vs Phase 2).",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "value", "note"],
				properties: {
					label: { type: "string" },
					value: { type: "string" },
					note: { type: "string" }
				}
			}
		},
		de_risk_summary: {
			type: "array",
			description: "Exactly 2 cards on how Spikra de-risks delivery (Hypercare and confirmed integration).",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "value", "note"],
				properties: {
					label: { type: "string" },
					value: { type: "string" },
					note: { type: "string" }
				}
			}
		}
	}
};

// Pure renderer: consumes Function 3's structured Zia Agent JSON and hydrates the FIXED master
// template below. Zero AI calls happen anywhere in this file.
module.exports = async (context, basicIO) => {
	let app = null;
	let projectId = "";
	let documentId = "";
	let experienceId = "";
	let generateJob = null;
	let generateJobId = "";

	try {
		let rawProjectId = basicIO.getArgument("project_id");
		if (!rawProjectId) rawProjectId = basicIO.getArgument("projectId");

		let rawDocumentId = basicIO.getArgument("document_id");
		if (!rawDocumentId) rawDocumentId = basicIO.getArgument("documentId");

		if (!rawProjectId || !rawDocumentId) {
			const bodyArg = basicIO.getArgument("req_body") || basicIO.getArgument("body") || basicIO.getArgument("BODY");
			if (bodyArg) {
				try {
					const parsedBody = typeof bodyArg === "string" ? JSON.parse(bodyArg) : bodyArg;
					if (parsedBody && typeof parsedBody === "object") {
						if (!rawProjectId) rawProjectId = parsedBody.project_id || parsedBody.projectId;
						if (!rawDocumentId) rawDocumentId = parsedBody.document_id || parsedBody.documentId;
					}
				} catch {}
			}
		}

		projectId = String(rawProjectId || "").trim();
		documentId = String(rawDocumentId || "").trim();

		if (!projectId) {
			throw new ValidationError("project_id is required.");
		}

		if (!documentId) {
			throw new ValidationError("document_id is required.");
		}

		app = catalyst.initialize(context);
		const datastore = app.datastore();
		const stratus = app.stratus();

		const projectsTable = datastore.table(PROJECTS_TABLE);
		const documentsTable = datastore.table(DOCUMENTS_TABLE);
		const experiencesTable = datastore.table(EXPERIENCES_TABLE);
		const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);

		let projectRow;
		try {
			projectRow = await projectsTable.getRow(projectId);
		} catch {
			throw new NotFoundError(`Project ${projectId} was not found.`);
		}

		if (!projectRow) {
			throw new NotFoundError(`Project ${projectId} was not found.`);
		}

		let documentRow;
		try {
			documentRow = await documentsTable.getRow(documentId);
		} catch {
			throw new NotFoundError(`Document ${documentId} was not found.`);
		}

		if (!documentRow) {
			throw new NotFoundError(`Document ${documentId} was not found.`);
		}

		const docProjectId = String(documentRow.project_id || "").trim();
		if (docProjectId !== projectId) {
			throw new ValidationError(`Document ${documentId} does not belong to project ${projectId}.`);
		}

		const contentObjectKey = String(
			documentRow.content_object_key ||
			`projects/${projectId}/documents/${documentId}/extracted-content.txt`
		).trim();

		const rawBusinessName = String(
			projectRow.business_name ||
			documentRow.business_name ||
			"Spikra Partner"
		).trim();
		const businessName = rawBusinessName.replace(/~\d+/g, "").trim() || "Spikra Partner";

		const projectName = String(
			projectRow.project_name ||
			documentRow.file_name ||
			"Customer Proposal"
		).trim();

		const analysisObjectKey = String(
			documentRow.analysis_object_key ||
			`projects/${projectId}/analysis/document-${documentId}-analysis.json`
		).trim();

		context.log(`Function 4 processing start: project_id=${projectId}, document_id=${documentId}, business=${businessName}`);

		generateJob = await findProcessingJob(app, documentId, "GENERATE");
		if (generateJob) {
			generateJobId = getRowId(generateJob);
			try {
				await processingJobsTable.updateRow({
					ROWID: generateJobId,
					status: "RUNNING",
					attempt_count: Number(generateJob.attempt_count || 0) + 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				context.log(`GENERATE job ${generateJobId} updated to RUNNING`);
			} catch (jobErr) {
				context.log("Notice: Failed to update existing GENERATE job:", jobErr.message);
			}
		}

		const existingExperience = await findExperience(app, documentId, projectId);

		if (existingExperience) {
			experienceId = getRowId(existingExperience);
			context.log(`Found existing experience record: ${experienceId}, status: ${existingExperience.status}`);

			const isExistingComplete =
				(existingExperience.status === "GENERATED" || existingExperience.status === "PUBLISHED") &&
				existingExperience.content_object_key;

			if (isExistingComplete) {
				const expectedKey = `projects/${projectId}/experiences/${experienceId}/version-1/`;
				const genBucket = stratus.bucket(GENERATED_BUCKET_NAME);
				let filesOk = false;
				try {
					const testHtml = await genBucket.getObject(`${expectedKey}index.html`);
					if (testHtml) filesOk = true;
				} catch {
					filesOk = false;
				}

				if (filesOk) {
					context.log(`Idempotent hit: Experience ${experienceId} already completed with verified files (status: ${existingExperience.status}). Skipping AI generation.`);
					if (generateJob && generateJobId) {
						await processingJobsTable.updateRow({
							ROWID: generateJobId,
							status: "COMPLETED",
							completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
							error_message: ""
						}).catch(() => {});
					}

					basicIO.setStatus(200);
					basicIO.write(
						JSON.stringify({
							success: true,
							message: "Customer experience generated successfully",
							project_id: projectId,
							document_id: documentId,
							experience_id: experienceId,
							status: existingExperience.status,
							content_object_key: expectedKey,
							files: [
								"index.html",
								"styles.css",
								"script.js",
								"experience.json"
							]
						})
					);
					return;
				}
			}

			await experiencesTable.updateRow({
				ROWID: experienceId,
				status: "GENERATING",
				error_message: ""
			});
		} else {
			const defaultTitle = `${businessName} - ${projectName}`;
			const newExpRow = await experiencesTable.insertRow({
				project_id: projectId,
				document_id: documentId,
				business_name: businessName,
				experience_title: defaultTitle.slice(0, 255),
				status: "GENERATING",
				version_number: 1,
				error_message: ""
			});
			experienceId = getRowId(newExpRow);
			context.log(`Created new experience record: ${experienceId}`);
		}

		if (!experienceId) {
			throw new ProcessingError("Could not resolve a valid experience_id from Data Store.");
		}

		if (!generateJob) {
			try {
				generateJob = await processingJobsTable.insertRow({
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					job_type: "GENERATE",
					status: "RUNNING",
					attempt_count: 1,
					started_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				generateJobId = getRowId(generateJob);
				context.log(`Created new GENERATE job: ${generateJobId}`);
			} catch (newJobErr) {
				context.log("Notice: Failed to insert new GENERATE job:", newJobErr.message);
			}
		}

		let extractedTextStream = null;
		try {
			const b = stratus.bucket(PROCESS_BUCKET_NAME);
			extractedTextStream = await b.getObject(contentObjectKey);
		} catch {}

		if (!extractedTextStream) {
			throw new NotFoundError("Extracted text object was not found in Stratus.");
		}

		const extractedTextBuffer = await streamToBuffer(extractedTextStream);
		if (!extractedTextBuffer || extractedTextBuffer.length === 0) {
			throw new ProcessingError("Extracted text object in Stratus is empty.");
		}

		if (extractedTextBuffer.length > MAX_DOCUMENT_TEXT_SIZE) {
			throw new ProcessingError("Extracted text exceeds the supported size limit.");
		}

		const extractedText = extractedTextBuffer.toString("utf8").trim();
		if (!extractedText) {
			throw new ProcessingError("Extracted text is empty.");
		}

		context.log(`Extracted text retrieved: length=${extractedText.length} characters`);

		let analysisStream = null;
		try {
			const generatedBucket = stratus.bucket(GENERATED_BUCKET_NAME);
			analysisStream = await generatedBucket.getObject(analysisObjectKey);
		} catch {}

		if (!analysisStream) {
			throw new NotFoundError("Analysis JSON was not found in Stratus. Please ensure Function 3 has executed.");
		}

		const analysisBuffer = await streamToBuffer(analysisStream);
		if (!analysisBuffer || analysisBuffer.length === 0) {
			throw new ProcessingError("Analysis JSON object in Stratus is empty.");
		}

		if (analysisBuffer.length > MAX_ANALYSIS_SIZE) {
			throw new ProcessingError("Analysis JSON exceeds maximum permitted size.");
		}

		let analysisJson;
		try {
			analysisJson = JSON.parse(analysisBuffer.toString("utf8"));
		} catch {
			throw new ProcessingError("Analysis JSON in Stratus is not valid JSON.");
		}

		if (!analysisJson || typeof analysisJson !== "object") {
			throw new ProcessingError("Analysis JSON must be a valid JSON object.");
		}

		context.log(`Analysis JSON retrieved: title=${analysisJson.proposal_title}`);

		let logoRelativePath = null;
		let generatedLogoObjectKey = null;
		const rawLogoKey = String(projectRow.business_logo_object_key || "").trim();

		if (rawLogoKey) {
			try {
				let logoStream = null;
				try {
					const processBucket = stratus.bucket(PROCESS_BUCKET_NAME);
					logoStream = await processBucket.getObject(rawLogoKey);
				} catch {}

				if (logoStream) {
					const logoBuffer = await streamToBuffer(logoStream);
					if (logoBuffer && logoBuffer.length > 0) {
						const ext = path.extname(rawLogoKey).toLowerCase() || ".png";
						const targetLogoKey = `projects/${projectId}/experiences/${experienceId}/version-1/assets/business-logo${ext}`;
						const targetContentType = getContentTypeByExt(ext);

						const generatedBucket = stratus.bucket(GENERATED_BUCKET_NAME);
						await generatedBucket.putObject(targetLogoKey, logoBuffer, {
							overwrite: true,
							contentType: targetContentType,
							metaData: {
								project_id: projectId,
								experience_id: experienceId,
								file_type: "business_logo"
							}
						});

						logoRelativePath = `assets/business-logo${ext}`;
						generatedLogoObjectKey = targetLogoKey;
						context.log(`Business logo copied successfully to: ${targetLogoKey}`);
					}
				}
			} catch (logoErr) {
				context.log("Notice: Business logo copy failed:", logoErr.message);
			}
		}

		const customerContent = prepareCustomerContent({
			analysisJson,
			businessName,
			projectName
		});

		context.log(`Customer content ready for template rendering: ${customerContent.capabilities.length} capabilities, ${customerContent.timeline_phases.length} timeline phases`);

		const masterTemplate = loadMasterTemplate();
		const renderedHtml = renderMasterTemplate(masterTemplate, customerContent, {
			businessName,
			projectName,
			logoRelativePath
		});
		const templateCss = extractTemplateCss(masterTemplate);
		const templateJs = extractTemplateJs(renderedHtml);

		const experienceMetadata = {
			project_id: projectId,
			document_id: documentId,
			experience_id: experienceId,
			business_name: businessName,
			experience_title: customerContent.proposal_title,
			template: {
				name: "spikra-customer-experience-template",
				source: "templates/iSteel_Proposal_Site.html",
				version: "2.0"
			},
			branding: {
				logo_available: Boolean(logoRelativePath),
				logo_file: logoRelativePath || null
			},
			content: customerContent,
			generated_at: new Date().toISOString(),
			files: [
				"index.html",
				"styles.css",
				"script.js",
				"experience.json"
			]
		};

		const generatedExperienceJson = JSON.stringify(experienceMetadata, null, 2);

		const experienceBaseKey = `projects/${projectId}/experiences/${experienceId}/version-1`;
		const generatedObjectPath = `${experienceBaseKey}/`;
		const generatedBucket = stratus.bucket(GENERATED_BUCKET_NAME);

		await generatedBucket.putObject(
			`${experienceBaseKey}/index.html`,
			Buffer.from(renderedHtml, "utf8"),
			{
				overwrite: true,
				contentType: "text/html; charset=utf-8",
				metaData: {
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					file_type: "html"
				}
			}
		);

		await generatedBucket.putObject(
			`${experienceBaseKey}/styles.css`,
			Buffer.from(templateCss, "utf8"),
			{
				overwrite: true,
				contentType: "text/css; charset=utf-8",
				metaData: {
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					file_type: "css"
				}
			}
		);

		await generatedBucket.putObject(
			`${experienceBaseKey}/script.js`,
			Buffer.from(templateJs, "utf8"),
			{
				overwrite: true,
				contentType: "application/javascript; charset=utf-8",
				metaData: {
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					file_type: "javascript"
				}
			}
		);

		await generatedBucket.putObject(
			`${experienceBaseKey}/experience.json`,
			Buffer.from(generatedExperienceJson, "utf8"),
			{
				overwrite: true,
				contentType: "application/json; charset=utf-8",
				metaData: {
					project_id: projectId,
					document_id: documentId,
					experience_id: experienceId,
					file_type: "metadata"
				}
			}
		);

		context.log(`Experience files successfully uploaded to: ${generatedObjectPath}`);

		const updateData = {
			ROWID: experienceId,
			experience_title: customerContent.proposal_title.slice(0, 255),
			business_name: businessName,
			status: "GENERATED",
			content_object_key: generatedObjectPath,
			version_number: 1,
			error_message: ""
		};

		if (rawLogoKey) {
			updateData.business_logo_object_key = rawLogoKey;
		}
		if (generatedLogoObjectKey) {
			updateData.generated_logo_object_key = generatedLogoObjectKey;
		}

		try {
			await experiencesTable.updateRow(updateData);
			context.log(`EXPERIENCES record ${experienceId} updated to GENERATED`);
		} catch (expErr) {
			context.log("Notice: Retrying EXPERIENCES update without extra logo columns:", expErr.message);
			await experiencesTable.updateRow({
				ROWID: experienceId,
				experience_title: customerContent.proposal_title.slice(0, 255),
				business_name: businessName,
				status: "GENERATED",
				content_object_key: generatedObjectPath,
				version_number: 1,
				error_message: ""
			});
		}

		if (generateJobId) {
			try {
				await processingJobsTable.updateRow({
					ROWID: generateJobId,
					status: "COMPLETED",
					completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
					error_message: ""
				});
				context.log(`GENERATE job ${generateJobId} marked as COMPLETED`);
			} catch (jobErr) {
				context.log("Notice: Failed to mark GENERATE job as COMPLETED:", jobErr.message);
			}
		}

		try {
			await projectsTable.updateRow({
				ROWID: projectId,
				status: "GENERATED"
			});
			context.log(`PROJECTS record ${projectId} updated to GENERATED`);
		} catch (projErr) {
			context.log("Notice: Failed to update PROJECTS record:", projErr.message);
		}

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: true,
				message: "Customer experience generated successfully",
				project_id: projectId,
				document_id: documentId,
				experience_id: experienceId,
				status: "GENERATED",
				content_object_key: generatedObjectPath,
				files: [
					"index.html",
					"styles.css",
					"script.js",
					"experience.json"
				]
			})
		);
	} catch (error) {
		const safeErrorMessage = sanitizeErrorMessage(error);
		context.log("spikra_experience_generate failed:", safeErrorMessage);

		await markGenerateFailure(app, experienceId, generateJobId, safeErrorMessage);

		basicIO.setStatus(200);
		basicIO.write(
			JSON.stringify({
				success: false,
				message: "Customer experience generation failed",
				project_id: projectId,
				document_id: documentId,
				experience_id: experienceId,
				status: "FAILED",
				error: safeErrorMessage
			})
		);
	} finally {
		context.close();
	}
};

function prepareCustomerContent({ analysisJson = {}, businessName, projectName }) {
	if (
		analysisJson &&
		(analysisJson.deliverable_cards || analysisJson.capabilities || analysisJson.customer_benefits)
	) {
		return normalizeExperienceContent(analysisJson, { analysisJson, businessName, projectName });
	}

	return fallbackSimplifyContent({ analysisJson, businessName, projectName });
}

async function simplifyCustomerContent(args) {
	return prepareCustomerContent(args);
}

function fallbackSimplifyContent({ analysisJson = {}, businessName, projectName }) {
	const cleanStr = (val, def = "") => {
		if (typeof val !== "string" || !val.trim() || val.trim().toLowerCase() === "not specified in the source document") {
			return def;
		}
		return val.trim();
	};

	const firstSentence = (val, maxWords = 18) => {
		const s = cleanStr(val);
		if (!s) return "";
		const first = s.split(/[.!?](?:\s|$)/)[0].trim();
		const words = first.split(/\s+/);
		if (words.length > maxWords) {
			return words.slice(0, maxWords).join(" ") + "...";
		}
		return first + (first.endsWith(".") ? "" : ".");
	};

	let title = cleanStr(analysisJson.proposal_title);
	if (!title || title.length > 80) {
		title = projectName && projectName !== "Customer Proposal" ? projectName : "Zoho CRM & Digital Transformation";
	}

	let summary = cleanStr(analysisJson.project_summary);
	if (!summary) {
		const solDesc = cleanStr(analysisJson.recommended_solution && analysisJson.recommended_solution.description);
		summary = solDesc || `A configured digital platform designed for ${businessName} to unify customer engagement, field workflows, and operational insights.`;
	}

	const solDesc = cleanStr(analysisJson.recommended_solution && analysisJson.recommended_solution.description);
	const whatWeDeliver = solDesc ? firstSentence(solDesc, 26) : `A configured engagement layer connecting customer touchpoints to core operational systems.`;
	const spikraWay = "BRD-aligned delivery. Every assumption is made explicit and every open item flagged for the discovery workshop, so scope is confirmed before detailed design is locked.";
	const howWeSupport = "Per-system integration decisions, role-based user onboarding, and dedicated Hypercare through go-live.";

	const cards = [];
	const techList = Array.isArray(analysisJson.technical_ecosystem) ? analysisJson.technical_ecosystem : [];
	const mainPlatform = techList.length > 0 ? techList.slice(0, 2).join(" + ") : "Zoho CRM Platform";

	cards.push({
		label: "Platform",
		value: mainPlatform,
		note: "The central engagement layer connecting customer touchpoints to existing systems."
	});

	cards.push({
		label: "Scope",
		value: "Phased Delivery",
		note: "Structured rollout across agreed operational milestones to verify success early."
	});

	const modules = Array.isArray(analysisJson.modules) ? analysisJson.modules : [];
	const caps = Array.isArray(analysisJson.core_capabilities) ? analysisJson.core_capabilities : [];

	if (modules.length > 0) {
		cards.push({
			label: "Phase 1 Focus",
			value: modules[0].title || modules[0].name || "Customer Journeys",
			note: firstSentence(modules[0].description, 16) || "Streamlined communication and engagement journeys."
		});
	} else {
		cards.push({
			label: "Phase 1 Focus",
			value: "Communication Journeys",
			note: "Automated engagement and communication workflows across all channels."
		});
	}

	if (modules.length > 1) {
		cards.push({
			label: "Core Workflow",
			value: modules[1].title || modules[1].name || "Field & Sales Ops",
			note: firstSentence(modules[1].description, 16) || "Connected field operations and sales routing."
		});
	} else {
		cards.push({
			label: "Core Workflow",
			value: "Opportunity Tracking",
			note: "Structured pipeline visibility from initial lead to final conversion."
		});
	}

	const integrations = Array.isArray(analysisJson.integrations) ? analysisJson.integrations : [];
	if (integrations.length > 0) {
		const intItem = integrations[0];
		const intName = typeof intItem === "string" ? intItem : (intItem.name || "System Handshake");
		const intDesc = typeof intItem === "string" ? "Synchronized data exchange with core business systems." : (firstSentence(intItem.description, 16) || "Synchronized data exchange with core business systems.");
		cards.push({
			label: "Integration",
			value: intName,
			note: intDesc
		});
	} else {
		cards.push({
			label: "Integration",
			value: "Connected Endpoints",
			note: "Seamless data synchronization across all business platforms."
		});
	}

	cards.push({
		label: "Governance",
		value: "Audit & Visibility",
		note: "Role-based visibility, field history, and verifiable progress tracking."
	});

	let rawBenefits = Array.isArray(analysisJson.business_benefits) ? [...analysisJson.business_benefits] : [];
	if (rawBenefits.length < 6 && Array.isArray(analysisJson.business_goals)) {
		rawBenefits.push(...analysisJson.business_goals);
	}
	if (rawBenefits.length === 0) {
		rawBenefits = [
			`Structured, lifecycle-tailored operational workflows configured for ${businessName}.`,
			"Automated synchronization across operational platforms with complete audit trail.",
			"Real-time pipeline visibility and role-based tracking across all stages.",
			"Simplified onboarding flows that reduce administrative and field friction.",
			"Data-backed performance metrics and comprehensive management dashboards.",
			"Dedicated support and Hypercare to ensure high adoption and smooth launch."
		];
	}

	const customerBenefits = rawBenefits.slice(0, 8).map(b => {
		const text = typeof b === "string" ? b : (b.title || b.description || "");
		return firstSentence(text, 22);
	}).filter(Boolean);

	const capabilities = [];
	const sourceCaps = modules.length >= 5 ? modules : (caps.length >= 5 ? caps : [...modules, ...caps]);

	if (sourceCaps.length > 0) {
		sourceCaps.slice(0, 8).forEach((item, idx) => {
			const itemTitle = cleanStr(item.title || item.name || `Solution Capability ${idx + 1}`);
			const itemDesc = cleanStr(item.description);
			capabilities.push({
				title: itemTitle,
				subtitle: item.features && Array.isArray(item.features) && item.features.length > 0 ? item.features[0] : "Spikra capability",
				teaser: firstSentence(itemDesc, 6).replace(/\.$/, "") || "Streamlined operational workflow",
				description: itemDesc || `Configured ${itemTitle} functionality supporting ${businessName} business objectives.`
			});
		});
	} else {
		capabilities.push(
			{
				title: "Customer Communication Journeys",
				subtitle: "Multi-channel automated outreach",
				teaser: "Every customer nurtured, start to close",
				description: `Automated communication journeys across preferred channels with structured follow-ups and stage-based nurturing for ${businessName}.`
			},
			{
				title: "Streamlined Digital Onboarding",
				subtitle: "Frictionless digital registration",
				teaser: "Fast onboarding without field visits",
				description: "Partners and customers can register themselves through simple digital flows, accelerating onboarding and reducing manual effort."
			},
			{
				title: "Audience Segmentation & Outreach",
				subtitle: "Targeted category campaigns",
				teaser: "The right message for each segment",
				description: "Tailored communication streams based on customer profile, purchase patterns, and lifecycle stage."
			},
			{
				title: "Opportunity & Pipeline Tracking",
				subtitle: "Real-time visibility at source",
				teaser: "Every opportunity mapped accurately",
				description: "Field teams capture project data directly on mobile, classifying opportunities and maintaining complete stage history."
			},
			{
				title: "Territory Routing & Governance",
				subtitle: "Automated owner assignment",
				teaser: "Right opportunity to the right owner",
				description: "Qualified opportunities route automatically by geography to the right owner, with mandatory loss capture building market intelligence."
			}
		);
	}

	const timelinePhases = [];
	const workflowSteps = Array.isArray(analysisJson.workflow_steps) ? analysisJson.workflow_steps : [];
	const milestones = Array.isArray(analysisJson.milestones) ? analysisJson.milestones : [];

	if (workflowSteps.length >= 3) {
		workflowSteps.slice(0, 4).forEach((step, idx) => {
			const phaseName = cleanStr(step.title || `Phase ${idx + 1}`);
			const phaseDesc = cleanStr(step.description);
			timelinePhases.push({
				name: phaseName,
				duration: idx === 0 ? "2–3 weeks" : idx === 1 ? "1–2 weeks" : "4–6 weeks",
				items: [
					firstSentence(phaseDesc, 14) || "Detailed requirements and technical configuration.",
					"Scope sign-off and milestone verification."
				],
				note: idx === 0 ? "Open items become confirmed scope before detailed design is locked." : null
			});
		});
	} else if (milestones.length >= 3) {
		milestones.slice(0, 4).forEach((m, idx) => {
			timelinePhases.push({
				name: cleanStr(m.title || `Stage ${idx + 1}`),
				duration: idx === 0 ? "2–3 weeks" : "4–6 weeks",
				items: [
					firstSentence(m.description, 14) || "Milestone deliverables and configuration.",
					"Quality assurance and review."
				],
				note: null
			});
		});
	} else {
		timelinePhases.push(
			{
				name: "Discovery Workshop",
				duration: "2–3 weeks",
				items: [
					`Evaluate solution requirements against ${businessName} business criteria`,
					"Discovery workshop to close open technical dependencies and confirm integration mechanism",
					"Confirm API availability and data models before locking detailed design"
				],
				note: "Open items become confirmed scope before detailed design is signed off."
			},
			{
				name: "Contract & Kickoff",
				duration: "1–2 weeks",
				items: [
					"Commercial agreement and project mobilization",
					"Team onboarding and environment provisioning",
					"Detailed design sign-off on the confirmed scope"
				],
				note: null
			},
			{
				name: "Phase 1 — Core Build & Journeys",
				duration: "4–6 weeks",
				items: [
					"Configure engagement platform and core communication journeys",
					"Automated segmentation, notification triggers, and user roles",
					"User acceptance testing, data validation, and Phase 1 go-live"
				],
				note: "Runs alongside existing operations to ensure seamless transition."
			},
			{
				name: "Phase 2 — Advanced Workflows & Integration",
				duration: "4–6 weeks",
				items: [
					"Field capture data models, opportunity routing, and mandatory loss tracking",
					"Bi-directional system integration and reporting dashboards",
					"Role-based end-user training, UAT sign-off, and full go-live"
				],
				note: "Backed by dedicated Hypercare support through initial operation."
			}
		);
	}

	const rolloutOverview = [
		{
			label: "Phase 1",
			value: "Foundation & Journeys",
			note: "Structured communication and core platform configuration established first, running alongside existing operations."
		},
		{
			label: "Phase 2",
			value: "Operations & Workflows",
			note: "Advanced field-to-sales routing, custom data models, integration handshakes, and executive reporting."
		}
	];

	const deRiskSummary = [
		{
			label: "Through go-live",
			value: "Hypercare on hand",
			note: "Adoption is the real risk. Spikra validates field workflows, conducts role-based training, and stays hands-on through dedicated Hypercare."
		},
		{
			label: "Integration",
			value: "Confirmed per system",
			note: "Integration mechanisms are decided per system on their merits, starting with validated handshakes and upgrading to APIs once confirmed."
		}
	];

	return {
		proposal_title: title,
		project_summary: summary,
		what_we_deliver: whatWeDeliver,
		spikra_way: spikraWay,
		how_we_support: howWeSupport,
		deliverable_cards: cards,
		customer_benefits: customerBenefits,
		capabilities,
		timeline_phases: timelinePhases,
		rollout_overview: rolloutOverview,
		de_risk_summary: deRiskSummary
	};
}

function normalizeExperienceContent(rawContent, fallbackContext) {
	const fallback = fallbackSimplifyContent(fallbackContext);
	if (!rawContent || typeof rawContent !== "object") {
		return fallback;
	}

	const title = (rawContent.proposal_title && String(rawContent.proposal_title).trim()) || fallback.proposal_title;
	const summary = (rawContent.project_summary && String(rawContent.project_summary).trim()) || fallback.project_summary;
	const whatWeDeliver = (rawContent.what_we_deliver && String(rawContent.what_we_deliver).trim()) || fallback.what_we_deliver;
	const spikraWay = (rawContent.spikra_way && String(rawContent.spikra_way).trim()) || fallback.spikra_way;
	const howWeSupport = (rawContent.how_we_support && String(rawContent.how_we_support).trim()) || fallback.how_we_support;

	let cards = Array.isArray(rawContent.deliverable_cards) && rawContent.deliverable_cards.length > 0 ? rawContent.deliverable_cards : fallback.deliverable_cards;
	if (cards.length > 6) cards = cards.slice(0, 6);
	while (cards.length < 6) {
		cards.push(fallback.deliverable_cards[cards.length]);
	}

	let benefits = Array.isArray(rawContent.customer_benefits) && rawContent.customer_benefits.length >= 4 ? rawContent.customer_benefits : fallback.customer_benefits;
	if (benefits.length > 8) benefits = benefits.slice(0, 8);

	let capabilities = Array.isArray(rawContent.capabilities) && rawContent.capabilities.length >= 4 ? rawContent.capabilities : fallback.capabilities;
	if (capabilities.length > 8) capabilities = capabilities.slice(0, 8);
	while (capabilities.length < 5 && fallback.capabilities[capabilities.length]) {
		capabilities.push(fallback.capabilities[capabilities.length]);
	}

	let timeline = Array.isArray(rawContent.timeline_phases) && rawContent.timeline_phases.length >= 3 ? rawContent.timeline_phases : fallback.timeline_phases;
	if (timeline.length > 5) timeline = timeline.slice(0, 5);

	const rollout = Array.isArray(rawContent.rollout_overview) && rawContent.rollout_overview.length === 2 ? rawContent.rollout_overview : fallback.rollout_overview;
	const deRisk = Array.isArray(rawContent.de_risk_summary) && rawContent.de_risk_summary.length === 2 ? rawContent.de_risk_summary : fallback.de_risk_summary;

	return {
		proposal_title: title,
		project_summary: summary,
		what_we_deliver: whatWeDeliver,
		spikra_way: spikraWay,
		how_we_support: howWeSupport,
		deliverable_cards: cards,
		customer_benefits: benefits,
		capabilities,
		timeline_phases: timeline,
		rollout_overview: rollout,
		de_risk_summary: deRisk
	};
}

function loadMasterTemplate() {
	const localPath = path.join(__dirname, "template.html");
	if (fs.existsSync(localPath)) {
		return fs.readFileSync(localPath, "utf8");
	}

	const repoPath = path.join(__dirname, "../../templates/iSteel_Proposal_Site.html");
	if (fs.existsSync(repoPath)) {
		return fs.readFileSync(repoPath, "utf8");
	}

	const altPath = path.join(__dirname, "../templates/iSteel_Proposal_Site.html");
	if (fs.existsSync(altPath)) {
		return fs.readFileSync(altPath, "utf8");
	}

	throw new ProcessingError("Master template file (iSteel_Proposal_Site.html / template.html) was not found.");
}

function renderMasterTemplate(templateString, content, { businessName, projectName, logoRelativePath }) {
	let html = templateString;

	const safeTitle = escapeHtml(content.proposal_title || `${projectName}`);
	const safeBusinessName = escapeHtml(businessName);
	const safeDescription = escapeHtml(content.project_summary || `Technical proposal for ${businessName}, BRD-aligned`);

	html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safeBusinessName} · ${safeTitle} | Spikra</title>`);
	html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i, () => `<meta name="description" content="Technical proposal — ${safeTitle} for ${safeBusinessName}, BRD-aligned">`);

	if (!html.includes('<link rel="stylesheet" href="styles.css">')) {
		html = html.replace(
			/(<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet">)/i,
			(match) => `${match}\n<link rel="stylesheet" href="styles.css">`
		);
	}

	const googleFontsLink = '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
	html = html
		.replace(/\$1\s*(<link rel="stylesheet")/gi, `${googleFontsLink}\n$1`)
		.replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\s*\$1/gi, `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n${googleFontsLink}`)
		.replace(/^\s*\$1\s*$/gm, "")
		.replace(/>\s*\$1\s*</g, "><");

	html = html.replace(/<h1>[\s\S]*?<\/h1>/i, () => `<h1>${safeTitle} for ${safeBusinessName}</h1>`);
	html = html.replace(/<p class="hero-sub">[\s\S]*?<\/p>/i, () => `<p class="hero-sub">Prepared for <strong>${safeBusinessName}</strong>. ${escapeHtml(content.project_summary)}</p>`);

	const initials = businessName.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "SP";
	let clientLogoHtml = "";
	if (logoRelativePath) {
		clientLogoHtml = `<div class="client-logo"><img src="${escapeHtml(logoRelativePath)}" alt="${safeBusinessName} logo"><h3 style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:var(--deep);margin-top:8px;text-align:center;">${safeBusinessName}</h3></div>`;
	} else {
		clientLogoHtml = `<div class="client-logo"><div class="client-logo-fallback" style="width:76px;height:76px;border-radius:12px;background:var(--flame-soft);color:var(--flame);display:grid;place-items:center;font-size:24px;font-weight:700;margin:0 auto;">${escapeHtml(initials)}</div><h3 style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:var(--deep);margin-top:8px;text-align:center;">${safeBusinessName}</h3></div>`;
	}
	html = html.replace(/<div class="client-logo">[\s\S]*?<\/div>/i, () => clientLogoHtml);

	const methodHtml = `<div class="method">
    <div class="mcell">
      <h3><span class="mi">◆</span>What we deliver</h3>
      <p>${escapeHtml(content.what_we_deliver)}</p>
    </div>
    <div class="mcell">
      <h3><span class="mi">◆</span>The Spikra way</h3>
      <p>${escapeHtml(content.spikra_way)}</p>
    </div>
    <div class="mcell">
      <h3><span class="mi">◆</span>How we support you</h3>
      <p>${escapeHtml(content.how_we_support)}</p>
    </div>
  </div>`;
	html = html.replace(/<div class="method">[\s\S]*?<\/div>\s*<\/section>/i, () => `${methodHtml}\n</section>`);

	const deliverableCardsHtml = (content.deliverable_cards || []).map((card, idx) => {
		const accentClass = (idx === 1 || idx === 2) ? " accent" : "";
		return `<div class="kpi${accentClass}"><div class="k-label">${escapeHtml(card.label)}</div><div class="k-value">${escapeHtml(card.value)}</div><div class="k-note">${escapeHtml(card.note)}</div></div>`;
	}).join("\n      ");

	const benefitsHtml = (content.customer_benefits || []).map(b => `<li>${escapeHtml(b)}</li>`).join("\n      ");

	const deliverablesPanelHtml = `<section class="panel active" id="deliverables" role="tabpanel">
    <div class="plabel">What Spikra will build for ${safeBusinessName}</div>
    <div class="grid g3">
      ${deliverableCardsHtml}
    </div>

    <div class="plabel">What ${safeBusinessName} gets from the move</div>
    <ul class="check">
      ${benefitsHtml}
    </ul>
  </section>`;

	html = html.replace(/<section class="panel active" id="deliverables" role="tabpanel">[\s\S]*?<\/section>/i, () => deliverablesPanelHtml);

	const capabilitiesHtml = (content.capabilities || []).map((cap, idx) => {
		const openClass = idx === 0 ? " open" : "";
		const svgIcon = CURATED_CAPABILITY_SVGS[idx % CURATED_CAPABILITY_SVGS.length];
		const subtitleHtml = cap.subtitle ? ` <small>${escapeHtml(cap.subtitle)}</small>` : "";
		return `<button class="acc-item${openClass}" data-i="${idx}">
        <div class="acc-bar">
          <span class="acc-ic">${svgIcon}</span>
          <span class="acc-title">${escapeHtml(cap.title)}${subtitleHtml}</span>
          <span class="acc-tease">${escapeHtml(cap.teaser)}</span>
          <span class="acc-chev" aria-hidden="true">›</span>
        </div>
        <div class="acc-body"><p>${escapeHtml(cap.description)}</p></div>
      </button>`;
	}).join("\n\n      ");

	const capabilitiesPanelHtml = `<section class="panel" id="capabilities" role="tabpanel">
    <div class="plabel">The core solution capabilities — tap any capability</div>
    <div class="acc" id="acc">
      ${capabilitiesHtml}
    </div>
  </section>`;

	html = html.replace(/<section class="panel" id="capabilities" role="tabpanel">[\s\S]*?<\/section>/i, () => capabilitiesPanelHtml);

	const phases = content.timeline_phases || [];
	const chipsHtml = phases.map((phase, idx) => {
		const onClass = idx === 0 ? " on" : "";
		return `<button class="tl-chip${onClass}" data-phase="${idx}"><div class="tl-wk">${escapeHtml(phase.duration)}</div><div class="tl-name">${escapeHtml(phase.name)}</div></button>`;
	}).join("\n      ");

	const phase0 = phases[0] || { name: "Discovery & Requirements", duration: "2–3 weeks", items: ["Finalize architecture", "Validate milestones"], note: null };
	const phase0DetailHtml = `<h3>${escapeHtml(phase0.name)}</h3><div class="wk">${escapeHtml(phase0.duration)}</div>
    <ul>${phase0.items.map(it => `<li>${escapeHtml(it)}</li>`).join("")}</ul>
    ${phase0.note ? `<div class="tl-note">${escapeHtml(phase0.note)}</div>` : ""}`;

	const rolloutCardsHtml = (content.rollout_overview || []).map((card, idx) => {
		const accentClass = idx === 0 ? " accent" : "";
		return `<div class="kpi${accentClass}">
        <div class="k-label">${escapeHtml(card.label)}</div>
        <div class="k-value">${escapeHtml(card.value)}</div>
        <div class="k-note">${escapeHtml(card.note)}</div>
      </div>`;
	}).join("\n      ");

	const deRiskCardsHtml = (content.de_risk_summary || []).map((card, idx) => {
		const hlClass = idx === 0 ? " hl" : "";
		return `<div class="kpi${hlClass}">
        <div class="k-label">${escapeHtml(card.label)}</div>
        <div class="k-value">${escapeHtml(card.value)}</div>
        <div class="k-note">${escapeHtml(card.note)}</div>
      </div>`;
	}).join("\n      ");

	const timelinePanelHtml = `<section class="panel" id="timeline" role="tabpanel">
    <div class="plabel">Phased delivery — click a stage</div>
    <div class="tl" id="tlChips">
      ${chipsHtml}
    </div>
    <div class="tl-detail" id="tlDetail">${phase0DetailHtml}</div>

    <div class="plabel">Rollout focus</div>
    <div class="grid g2">
      ${rolloutCardsHtml}
    </div>

    <div class="plabel">How we de-risk delivery</div>
    <div class="grid g2">
      ${deRiskCardsHtml}
    </div>
  </section>`;

	html = html.replace(/<section class="panel" id="timeline" role="tabpanel">[\s\S]*?<\/section>/i, () => timelinePanelHtml);

	html = html.replace(
		/<span>Confidential[\s\S]*?<\/span>/i,
		() => `<span>Confidential — prepared exclusively for ${safeBusinessName} · abinash@spikra.com · +91 92407 03257</span>`
	);

	const scriptPhases = phases.map(p => ({
		name: p.name,
		wk: p.duration,
		items: p.items,
		note: p.note || null
	}));

	const phasesJs = `const PHASES = ${JSON.stringify(scriptPhases, null, 2)};`;
	html = html.replace(/const PHASES\s*=\s*\[[\s\S]*?\];/i, () => phasesJs);

	const dismissScript = `<script id="spikra-parent-dismiss-script">
(function() {
  function dismissParentLoader() {
    try {
      if (window.parent && window.parent !== window && window.parent.hideSpikraLoader) {
        window.parent.hideSpikraLoader();
      }
    } catch(e) {}
  }
  if (document.readyState === 'complete') {
    dismissParentLoader();
  } else {
    window.addEventListener('load', dismissParentLoader);
  }
})();
</script>`;

	if (!html.includes('<script src="script.js"></script>')) {
		html = html.replace("</body>", `<script src="script.js"></script>\n${dismissScript}\n</body>`);
	} else if (!html.includes('spikra-parent-dismiss-script')) {
		html = html.replace("</body>", `${dismissScript}\n</body>`);
	}

	html = html.replace(/\biSteel\s*(\(VIPL\))?/gi, safeBusinessName);
	html = html.replace(/\bVIPL\b/gi, safeBusinessName);

	return html;
}

function extractTemplateCss(templateString) {
	const styleMatch = templateString.match(/<style>([\s\S]*?)<\/style>/i);
	return styleMatch ? styleMatch[1].trim() : "";
}

function extractTemplateJs(renderedHtml) {
	const scriptMatch = renderedHtml.match(/<script>([\s\S]*?)<\/script>/i);
	if (scriptMatch) {
		return scriptMatch[1].trim();
	}
	return "";
}

function getContentTypeByExt(ext) {
	switch (ext) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".svg": return "image/svg+xml";
		default: return "image/png";
	}
}

async function markGenerateFailure(app, experienceId, generateJobId, errorMessage) {
	if (!app) return;
	const safeMsg = String(errorMessage || "Customer experience generation failed.").slice(0, 9000);

	try {
		const datastore = app.datastore();
		if (experienceId) {
			const experiencesTable = datastore.table(EXPERIENCES_TABLE);
			await experiencesTable.updateRow({
				ROWID: String(experienceId),
				status: "FAILED",
				error_message: safeMsg
			}).catch(() => {});
		}

		if (generateJobId) {
			const processingJobsTable = datastore.table(PROCESSING_JOBS_TABLE);
			await processingJobsTable.updateRow({
				ROWID: String(generateJobId),
				status: "FAILED",
				completed_time: new Date().toISOString().replace("T", " ").substring(0, 19),
				error_message: safeMsg
			}).catch(() => {});
		}
	} catch (failureErr) {
		console.error("Unable to update failure status:", failureErr);
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

module.exports.prepareCustomerContent = prepareCustomerContent;
module.exports.simplifyCustomerContent = simplifyCustomerContent;
module.exports.fallbackSimplifyContent = fallbackSimplifyContent;
module.exports.loadMasterTemplate = loadMasterTemplate;
module.exports.renderMasterTemplate = renderMasterTemplate;
module.exports.extractTemplateCss = extractTemplateCss;
module.exports.extractTemplateJs = extractTemplateJs;
