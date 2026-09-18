"use strict";

function streamToBuffer(stream) {
	if (Buffer.isBuffer(stream)) {
		return Promise.resolve(stream);
	}
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

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function validateAnalysisSchema(obj) {
	if (!obj || typeof obj !== "object") return false;
	const requiredFields = [
		"proposal_title",
		"project_summary",
		"business_challenge",
		"recommended_solution",
		"target_users",
		"business_benefits",
		"modules",
		"workflow_steps"
	];
	for (const field of requiredFields) {
		if (obj[field] === undefined || obj[field] === null) {
			return false;
		}
	}
	return true;
}

function sanitizeErrorMessage(error) {
	const raw = error && error.message ? String(error.message) : "An unexpected processing error occurred.";
	return raw
		.replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
		.slice(0, 500);
}

/**
 * Format and sanitize a proposal or experience showcase URL.
 * Zoho Slate (onslate.com) hosts static assets and does not rewrite deep subpaths
 * to index.html. A path-based URL like https://spikra-ai-proposal.onslate.com/abc-pvt-ltd_proposal
 * returns Slate's 404 "Oops..Page not found".
 * Converting it to query-based format: https://spikra-ai-proposal.onslate.com/?slug=abc-pvt-ltd_proposal
 * allows Slate's index.html to load with HTTP 200, parse the slug, and fetch the proposal from Catalyst.
 */
function formatProposalUrl(rawUrl, experienceId = "", projectId = "") {
	if (!rawUrl || typeof rawUrl !== "string") return null;
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;

	try {
		const parsed = new URL(trimmed);
		const hostname = parsed.hostname.toLowerCase();
		if (hostname.includes("onslate.com")) {
			const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
			if (pathname && pathname.toLowerCase() !== "index.html" && pathname.toLowerCase() !== "404.html") {
				if (!parsed.searchParams.has("slug")) {
					parsed.searchParams.set("slug", pathname);
				}
				parsed.pathname = "/";
			}
			if (experienceId && !parsed.searchParams.has("experience_id")) {
				parsed.searchParams.set("experience_id", String(experienceId).trim());
			}
			if (projectId && !parsed.searchParams.has("project_id")) {
				parsed.searchParams.set("project_id", String(projectId).trim());
			}
			return parsed.toString();
		}
		return trimmed;
	} catch {
		return trimmed;
	}
}

module.exports = {
	streamToBuffer,
	escapeHtml,
	validateAnalysisSchema,
	sanitizeErrorMessage,
	formatProposalUrl
};

