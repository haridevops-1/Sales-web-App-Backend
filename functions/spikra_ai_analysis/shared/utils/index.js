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

module.exports = {
	streamToBuffer,
	escapeHtml,
	validateAnalysisSchema,
	sanitizeErrorMessage
};
