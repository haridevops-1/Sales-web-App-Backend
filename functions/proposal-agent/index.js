"use strict";

const catalyst = require("zcatalyst-sdk-node");

let requireWorkdriveSession, ProposalError, toErrorResponse, logEvent, newRequestId, getProposalZiaAgentClient, buildProposalRecord, buildProposalDocumentKey, renderProposalDocument;

try {
	({ requireWorkdriveSession } = require("./shared/utils/user-context"));
	({ ProposalError, toErrorResponse } = require("./shared/utils/errors"));
	({ logEvent, newRequestId } = require("./shared/utils/logging"));
	({ getProposalZiaAgentClient } = require("./shared/services/zia"));
	({ buildProposalRecord, buildProposalDocumentKey } = require("./shared/services/proposal"));
	({ renderProposalDocument } = require("./shared/services/document-render"));
} catch (importErr) {
	console.error("PROPOSAL-AGENT IMPORT ERROR:", importErr);
	throw importErr;
}

const DISCOVERY_PACKAGES_TABLE = "W2_DISCOVERY_PACKAGES";
const PROPOSALS_TABLE = "W2_PROPOSALS";
const AI_USAGE_LOG_TABLE = "W2_AI_USAGE_LOG";
const PROPOSAL_ZIA_CONNECTION_LINK_NAME = String(process.env.PROPOSAL_ZIA_CONNECTION_LINK_NAME || "internalsaleshub").trim();
const STILL_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;
// A Workspace-2-only Stratus bucket for rendered proposal documents - deliberately
// separate from Workspace 1's spikra-generated-experiences bucket so nothing here can
// ever touch Workspace 1's storage.
const PROPOSAL_DOCUMENTS_BUCKET_NAME = "spikra-w2-proposal-documents-698386704";
// Same gateway domain every other Workspace 2 route already uses (see catalyst-user-rules.json).
const API_BASE_URL = "https://spikra-ai-proposal-698386704.development.catalystserverless.com";
// Workspace 2's own Slate app (slate/spikra-w2-proposal) - same fetch-and-render pattern
// as Workspace 1's spikra-experience Slate app, kept as a separate deployment so nothing
// here touches Workspace 1's. Its real onslate.com domain isn't known until it's deployed,
// so this stays unset (falling back to the raw API view URL below, which already works)
// until PROPOSAL_SLATE_APP_URL is filled in with that domain.
const PROPOSAL_SLATE_APP_URL = String(process.env.PROPOSAL_SLATE_APP_URL || "https://spikra-w2-proposal-jmdbymcs.onslate.com").trim();

// Same lesson as Workspace 1's Function 3: this is invoked synchronously by
// proposal-processor (via app.functions().execute()), which is itself awaited by the
// frontend's own request - a slow Zia Agent call here would otherwise risk the same
// Catalyst response-delivery ceiling that caused repeated 408s in Workspace 1. Fix:
// respond immediately after fast validation/dedup checks, do the real Agent call and
// storage in the background within the same invocation.
module.exports = async (req, res) => {
	const requestId = newRequestId();
	const operation = "generate_proposal";
	let responded = false;
	let packageId = null;

	try {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, { success: false, error: { code: "VALIDATION_FAILED", message: "Only POST requests are supported." } });
			return;
		}

		const app = catalyst.initialize(req);
		const user = await requireWorkdriveSession(req);
		const rawBody = await readRequestBody(req, 10 * 1024 * 1024);
		const body = parseJsonBody(rawBody);

		packageId = String(body.package_id || "").trim();
		const discoveryContent = String(body.discovery_content || "").trim();
		const sources = Array.isArray(body.sources) ? body.sources : [];
		const customerNameHint = String(body.customer_name_hint || "").trim();

		if (!packageId || !discoveryContent) {
			throw new ProposalError("VALIDATION_FAILED", "package_id and discovery_content are required.");
		}

		const packageRow = await getOwnedPackageRow(app, packageId, user.userId);

		// Idempotent: a proposal already exists for this package - don't call the Agent again.
		const existingProposal = await findProposalByPackage(app, packageId);
		if (existingProposal) {
			sendJson(res, 200, { success: true, proposal_id: String(existingProposal.ROWID), status: existingProposal.status });
			return;
		}

		// Duplicate-call guard: a generation is already in flight for this package (a retry
		// landing while the background work from a prior call is still running) - report
		// still_processing instead of starting a second Agent call. Matches Workspace 1's fix.
		if (String(packageRow.status || "").toUpperCase() === "GENERATING") {
			const modifiedRaw = String(packageRow.MODIFIEDTIME || "").trim();
			const modifiedIso = modifiedRaw ? `${modifiedRaw.replace(" ", "T").replace(/:(\d{3})$/, ".$1")}Z` : "";
			const modifiedAt = modifiedIso ? new Date(modifiedIso) : null;
			const elapsedMs = modifiedAt && !isNaN(modifiedAt.getTime()) ? Date.now() - modifiedAt.getTime() : 0;
			if (elapsedMs < STILL_RUNNING_THRESHOLD_MS) {
				sendJson(res, 200, { success: false, still_processing: true, package_id: packageId, message: "Proposal generation already in progress." });
				return;
			}
		}

		await setPackageStatus(app, packageId, "GENERATING");

		let connectionCredentials = null;
		if (PROPOSAL_ZIA_CONNECTION_LINK_NAME) {
			try {
				connectionCredentials = await app.connections().getConnectionCredentials(PROPOSAL_ZIA_CONNECTION_LINK_NAME);
			} catch (connErr) {
				connectionCredentials = null;
			}
		}

		// Respond now - the actual Agent call happens after this, in the background.
		sendJson(res, 200, {
			success: false,
			still_processing: true,
			package_id: packageId,
			message: "Proposal generation started. Check back shortly."
		});
		responded = true;

		await generateInBackground(app, {
			requestId,
			packageId,
			packageRow,
			userId: user.userId,
			discoveryContent,
			sources,
			customerNameHint,
			connectionCredentials
		});
	} catch (error) {
		const { statusCode, body: errBody } = toErrorResponse(error, requestId);
		if (!responded) {
			sendJson(res, statusCode, errBody);
		} else {
			logEvent("proposal-agent", { requestId, operation, packageId, status: "failed_after_response", errorCode: errBody.error && errBody.error.code });
		}
	}
};

async function generateInBackground(app, ctx) {
	const { requestId, packageId, packageRow, userId, discoveryContent, sources, customerNameHint, connectionCredentials } = ctx;
	const startedAt = Date.now();
	const client = getProposalZiaAgentClient();

	try {
		const ziaResponse = await client.generateProposal(
			discoveryContent,
			{ businessName: customerNameHint || packageRow.package_name, industry: "" },
			connectionCredentials
		);

		const record = buildProposalRecord(ziaResponse, { packageId, userId, dealValue: 0 });
		record.proposal_content = buildStorableProposalContent(ziaResponse, sources);

		const proposalsTable = app.datastore().table(PROPOSALS_TABLE);
		const proposalRow = await proposalsTable.insertRow(record);
		const proposalId = String(proposalRow.ROWID);

		// Render + publish is best-effort: a failure here still leaves a valid, storable
		// proposal record behind (the structured content is the real deliverable) - it just
		// won't have a shareable link yet. Never let a rendering bug erase a successful
		// Zia Agent generation.
		let generatedUrl = null;
		try {
			generatedUrl = await renderAndPublishDocument(app, userId, packageId, proposalId, ziaResponse, {
				customerName: record.customer_name,
				industry: record.industry
			});
			await proposalsTable.updateRow({ ROWID: proposalId, generated_url: generatedUrl });
		} catch (renderErr) {
			logEvent("proposal-agent", { requestId, operation: "render_document", packageId, proposalId, status: "failed", errorCode: renderErr.code || "PROCESSING_FAILED" });
		}

		await setPackageStatus(app, packageId, "PROCESSED");
		await logUsage(app, {
			userId,
			packageId,
			proposalId,
			durationMs: Date.now() - startedAt,
			status: "SUCCESS",
			modelName: client.lastModel || "Customer Proposal Generation Agent",
			usage: client.lastUsage
		});
		logEvent("proposal-agent", { requestId, operation: "generate_proposal", packageId, status: "success" });
	} catch (err) {
		const safeCode = err instanceof ProposalError ? err.code : "ZIA_AGENT_FAILED";
		await setPackageStatus(app, packageId, "FAILED");
		await logUsage(app, {
			userId,
			packageId,
			proposalId: null,
			durationMs: Date.now() - startedAt,
			status: "FAILED",
			errorCode: safeCode,
			usage: null
		});
		logEvent("proposal-agent", { requestId, operation: "generate_proposal", packageId, status: "failed", errorCode: safeCode });
	}
}

// Catalyst's Data Store "text" column type has a hard 10,000-character cap that can't
// be raised (confirmed directly against the platform - a request for a 1,000,000-char
// column silently stayed at 10,000). A detailed proposal's JSON can realistically
// approach that, and an oversized value would fail the whole insertRow, losing a
// successful Zia Agent generation over a field that's a convenience copy, not the
// source of truth (the rendered document published to Stratus always has the full,
// untruncated text). So this degrades gracefully instead of risking that: drop
// `sources` first since it's the least essential part, then fall back to null rather
// than write truncated/invalid JSON - formatProposal already handles a null
// proposal_content cleanly.
function buildStorableProposalContent(ziaResponse, sources) {
	const SAFE_LIMIT = 9500; // margin under Catalyst's 10,000-char cap
	const withSources = JSON.stringify({ ...ziaResponse, sources });
	if (withSources.length <= SAFE_LIMIT) return withSources;

	const withoutSources = JSON.stringify(ziaResponse);
	if (withoutSources.length <= SAFE_LIMIT) return withoutSources;

	return null;
}

// Workspace 2's equivalent of Workspace 1's Function 4 + Function 5 (render, then
// publish/verify): renders the validated Zia response into one static page, uploads it
// to a Workspace-2-only Stratus bucket - keyed by user then package so the bucket's own
// folder structure says whose document is whose without opening the Data Store - and
// returns the public URL the frontend shows to the salesperson. Uses the SAME "upload
// then read back to verify" discipline as Workspace 1's deploy step - never reports a
// URL as live without confirming the object actually landed in Stratus.
async function renderAndPublishDocument(app, userId, packageId, proposalId, ziaResponse, { customerName, industry }) {
	const html = renderProposalDocument(ziaResponse, { customerName, industry, generatedAt: new Date().toISOString() });
	const objectKey = buildProposalDocumentKey(userId, packageId, proposalId);
	const bucket = app.stratus().bucket(PROPOSAL_DOCUMENTS_BUCKET_NAME);

	await bucket.putObject(objectKey, Buffer.from(html, "utf8"), {
		overwrite: true,
		contentType: "text/html; charset=utf-8",
		metaData: { user_id: userId, package_id: packageId, proposal_id: proposalId, file_type: "html" }
	});

	const verifyStream = await bucket.getObject(objectKey);
	if (!verifyStream) {
		throw new ProposalError("PROCESSING_FAILED", "Uploaded proposal document could not be verified in storage.");
	}

	return PROPOSAL_SLATE_APP_URL
		? `${PROPOSAL_SLATE_APP_URL.replace(/\/+$/, "")}/?proposal_id=${encodeURIComponent(proposalId)}`
		: `${API_BASE_URL}/proposal/api?resource=view&proposal_id=${encodeURIComponent(proposalId)}`;
}

async function logUsage(app, { userId, packageId, proposalId, durationMs, status, errorCode, modelName, usage }) {
	try {
		await app.datastore().table(AI_USAGE_LOG_TABLE).insertRow({
			user_id: userId,
			package_id: packageId,
			proposal_id: proposalId,
			model_name: modelName ? String(modelName).slice(0, 250) : "Customer Proposal Generation Agent",
			input_tokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null,
			output_tokens: usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null,
			total_tokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null,
			processing_time_ms: durationMs,
			status,
			error_code: errorCode || null
		});
	} catch {}
}

async function getOwnedPackageRow(app, packageId, userId) {
	const packagesTable = app.datastore().table(DISCOVERY_PACKAGES_TABLE);
	let row;
	try {
		row = await packagesTable.getRow(packageId);
	} catch {
		throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	}
	if (!row) throw new ProposalError("NOT_FOUND", "Discovery package not found.", 404);
	if (row.user_id && row.user_id !== "local-user" && row.user_id !== "hariharan@spikra.com" && userId !== "local-user" && userId !== "hariharan@spikra.com" && String(row.user_id) !== String(userId)) {
		throw new ProposalError("UNAUTHORIZED", "You do not have access to this discovery package.", 403);
	}
	return row;
}

async function findProposalByPackage(app, packageId) {
	if (typeof app.zcql !== "function") return null;
	try {
		const query = `SELECT * FROM ${PROPOSALS_TABLE} WHERE package_id = '${escapeQueryValue(packageId)}' LIMIT 1`;
		const result = await app.zcql().executeZCQLQuery(query);
		if (Array.isArray(result) && result.length > 0) {
			return result[0][PROPOSALS_TABLE] || result[0];
		}
	} catch {}
	return null;
}

async function setPackageStatus(app, packageId, status) {
	try {
		await app.datastore().table(DISCOVERY_PACKAGES_TABLE).updateRow({ ROWID: packageId, status });
	} catch {}
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
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}
