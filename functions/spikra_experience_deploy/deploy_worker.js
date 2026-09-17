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

// Spikra publishes a single shared Slate app (deployed once via `catalyst deploy --only slate`);
// every business gets a unique link via query params/slug, never a dedicated app per customer.
const SLATE_APP_URL = process.env.SLATE_APP_URL || "https://spikra-ai-proposal.onslate.com";

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
	// The Slate app is a plain static host (no SPA/rewrite fallback configured), so a path like
	// /<slug> 404s before index.html's own routing script ever runs - only literal files (/, index.html)
	// resolve. index.html already reads ?slug=... for this exact reason, so the link must use that.
	const generatedUrl = `${SLATE_APP_URL}/?slug=${encodeURIComponent(slug)}`;

	return {
		success: true,
		slug,
		generated_url: generatedUrl
	};
}

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
		} catch {}
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
