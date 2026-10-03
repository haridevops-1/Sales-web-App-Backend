"use strict";

// Error code catalog for the shared Zoho WorkDrive integration (used by both Workspace 1
// and Workspace 2). Every failure here should throw a WorkdriveError with one of these
// codes so callers get a consistent, safe {success:false, error:{code,message}} body -
// never a stack trace, token, or secret.
const ERROR_CODES = {
	UNAUTHENTICATED: "You must connect your Zoho WorkDrive account first.",
	SESSION_EXPIRED: "Your WorkDrive session has expired. Please reconnect.",
	WORKDRIVE_AUTH_FAILED: "Unable to connect to Zoho WorkDrive.",
	WORKDRIVE_TOKEN_EXPIRED: "The WorkDrive connection has expired and needs to be reconnected.",
	WORKDRIVE_API_FAILED: "Zoho WorkDrive did not respond as expected.",
	WORKDRIVE_FILE_NOT_FOUND: "The requested WorkDrive file could not be found.",
	WORKDRIVE_PERMISSION_DENIED: "WorkDrive denied access to this folder or file.",
	FOLDER_NOT_FOUND: "The requested WorkDrive folder could not be found.",
	FILE_DOWNLOAD_FAILED: "Failed to download this file from WorkDrive.",
	VALIDATION_FAILED: "The request was invalid.",
	TIMEOUT: "The request timed out.",
	NOT_FOUND: "The requested resource was not found."
};

class WorkdriveError extends Error {
	constructor(code, message, statusCode = 400) {
		super(message || ERROR_CODES[code] || "An unexpected error occurred.");
		this.name = "WorkdriveError";
		this.code = ERROR_CODES.hasOwnProperty(code) ? code : "VALIDATION_FAILED";
		this.statusCode = statusCode;
	}
}

// Duck-typed on {code, statusCode} rather than `instanceof WorkdriveError` so a caller
// with its own similarly-shaped error class (e.g. Workspace 2's ProposalError) can reuse
// this without a cross-module class dependency.
function toErrorResponse(error, requestId) {
	if (error && typeof error.code === "string" && ERROR_CODES.hasOwnProperty(error.code)) {
		return {
			statusCode: error.statusCode || 400,
			body: {
				success: false,
				error: { code: error.code, message: error.message },
				request_id: requestId || null
			}
		};
	}
	return {
		statusCode: 500,
		body: {
			success: false,
			error: { code: "VALIDATION_FAILED", message: "An unexpected error occurred." },
			request_id: requestId || null
		}
	};
}

module.exports = { ERROR_CODES, WorkdriveError, toErrorResponse };
