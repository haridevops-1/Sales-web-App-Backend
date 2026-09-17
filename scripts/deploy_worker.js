"use strict";

const { URL } = require("url");
const https = require("https");
const http = require("http");

const GENERATED_BUCKET_NAME = "spikra-generated-experiences-698386704";

const REQUIRED_EXPERIENCE_FILES = [
	"index.html",
	"styles.css",
	"script.js",
	"experience.json"
];

/**
 * Spikra publishes a single shared Slate app (slate/spikra-experience), deployed once
 * via `catalyst deploy --only slate`.
 * The customer URL domain must ALWAYS be https://spikra-ai-proposal.onslate.com.
 */
const SLATE_APP_URL = process.env.SLATE_APP_URL || "https://spikra-ai-proposal.onslate.com";

/**
 * Generates a clean, deterministic, friendly URL slug from a business name.
 * Rules:
 * 1. Convert to lowercase
 * 2. Trim leading/trailing whitespace
 * 3. Replace unsupported characters with hyphen (-)
 * 4. Replace whitespace with hyphen (-)
 * 5. Collapse consecutive hyphens into one
 * 6. Remove leading/trailing hyphens
 * 7. Append _proposal
 *
 * Examples:
 * "Monin Pvt Ltd" -> "monin-pvt-ltd_proposal"
 * "ABC Manufacturing" -> "abc-manufacturing_proposal"
 * "ABC Manufacturing & Foods" -> "abc-manufacturing-foods_proposal"
 * "XYZ Logistics" -> "xyz-logistics_proposal"
 *
 * @param {string} businessName
 * @returns {string}
 */
function generateBusinessSlug(businessName) {
	if (!businessName || typeof businessName !== "string") {
		return "customer_proposal";
	}
	const sanitized = businessName
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");

	return `${sanitized || "customer"}_proposal`;
}

/**
 * Verifies the generated experience files exist and are non-empty in Stratus,
 * then returns the shared Slate app's friendly customer URL.
 *
 * Format: https://spikra-ai-proposal.onslate.com/{business-name}_proposal
 *
 * @param {object} params
 * @param {object} params.app - Initialized Catalyst SDK app
 * @param {string} params.projectId
 * @param {string} params.experienceId
 * @param {string} params.businessName
 * @returns {Promise<{ success: boolean, slug: string, generated_url: string }>}
 */
async function verifyAndBuildExperienceUrl({ app, projectId, experienceId, businessName }) {
	const stratus = app.stratus();
	const genBucket = stratus.bucket(GENERATED_BUCKET_NAME);
	const prefix = `projects/${projectId}/experiences/${experienceId}/version-1/`;

	for (const fileName of REQUIRED_EXPERIENCE_FILES) {
		const fileKey = `${prefix}${fileName}`;
		const stream = await genBucket.getObject(fileKey);
		const buffer = await streamToBuffer(stream);
		if (!buffer || buffer.length === 0) {
			throw new Error(`Required file '${fileName}' is empty in Stratus: ${fileKey}`);
		}
	}

	// Resolve businessName if not provided directly
	let resolvedBizName = String(businessName || "").trim();
	if (!resolvedBizName && app) {
		try {
			const datastore = app.datastore();
			if (projectId) {
				const projTable = datastore.table("PROJECTS");
				const projRow = await projTable.getRow(projectId).catch(() => null);
				if (projRow && projRow.business_name) {
					resolvedBizName = String(projRow.business_name).trim();
				}
			}
			if (!resolvedBizName && experienceId) {
				const expTable = datastore.table("EXPERIENCES");
				const expRow = await expTable.getRow(experienceId).catch(() => null);
				if (expRow && expRow.business_name) {
					resolvedBizName = String(expRow.business_name).trim();
				}
			}
		} catch (e) {
			console.log("Notice: Could not query business name for slug:", e.message);
		}
	}

	const slug = generateBusinessSlug(resolvedBizName);
	const generatedUrl = `${SLATE_APP_URL}/${slug}`;

	return {
		success: true,
		slug,
		generated_url: generatedUrl
	};
}

/**
 * Checks whether a deployed URL returns HTTP 200 (retries for DNS propagation).
 */
async function verifyUrlAccessible(testUrl, maxAttempts = 3) {
	for (let i = 1; i <= maxAttempts; i++) {
		try {
			const res = await new Promise((resolve) => {
				const parsed = new URL(testUrl);
				const client = parsed.protocol === "https:" ? https : http;
				const req = client.get(testUrl, { timeout: 5000 }, (r) => resolve(r));
				req.on("error", () => resolve(null));
				req.on("timeout", () => {
					req.destroy();
					resolve(null);
				});
			});

			if (res && res.statusCode >= 200 && res.statusCode < 400) {
				return true;
			}
		} catch {
			// ignore and retry
		}
		if (i < maxAttempts) {
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	return false;
}

function streamToBuffer(stream) {
	if (Buffer.isBuffer(stream)) {
		return Promise.resolve(stream);
	}
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

module.exports = {
	SLATE_APP_URL,
	generateBusinessSlug,
	verifyAndBuildExperienceUrl,
	verifyUrlAccessible
};
