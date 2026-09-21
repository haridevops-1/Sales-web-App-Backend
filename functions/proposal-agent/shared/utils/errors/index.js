"use strict";

// Error code catalog for Workspace 2. Every function-facing failure should throw a
// ProposalError with one of these codes so the HTTP layer can return a consistent,
// safe {success:false, error:{code,message}} body - never a stack trace, token, or secret.
const ERROR_CODES = {
	WORKDRIVE_AUTH_FAILED: "Unable to connect to Zoho WorkDrive.",
	WORKDRIVE_TOKEN_EXPIRED: "The WorkDrive connection has expired and needs to be reconnected.",
	WORKDRIVE_API_FAILED: "Zoho WorkDrive did not respond as expected.",
	WORKDRIVE_FILE_NOT_FOUND: "The requested WorkDrive file could not be found.",
	UNSUPPORTED_FILE_TYPE: "This file type is not supported for proposal generation.",
	EMPTY_FILE: "The file has no extractable content.",
	EXTRACTION_FAILED: "Failed to extract content from this file.",
	PROCESSING_FAILED: "Failed to process the discovery package.",
	ZIA_AGENT_FAILED: "The Zia Agent request failed.",
	INVALID_ZIA_RESPONSE: "The Zia Agent response did not match the expected structure.",
	VALIDATION_FAILED: "The request was invalid.",
	DATASTORE_FAILED: "A data store operation failed.",
	TIMEOUT: "The request timed out.",
	DUPLICATE_REQUEST: "This request is already being processed.",
	NOT_FOUND: "The requested resource was not found.",
	UNAUTHENTICATED: "You must be logged in to do this.",
	UNAUTHORIZED: "You do not have access to this resource.",
	SESSION_EXPIRED: "Your session has expired. Please log in again.",
	WORKDRIVE_PERMISSION_DENIED: "WorkDrive denied access to this folder or file.",
	FOLDER_NOT_FOUND: "The requested WorkDrive folder could not be found.",
	FILE_DOWNLOAD_FAILED: "Failed to download this file from WorkDrive."
};

class ProposalError extends Error {
	constructor(code, message, statusCode = 400) {
		super(message || ERROR_CODES[code] || "An unexpected error occurred.");
		this.name = "ProposalError";
		this.code = ERROR_CODES.hasOwnProperty(code) ? code : "VALIDATION_FAILED";
		this.statusCode = statusCode;
	}
}

// Matches Workspace 1's sanitizeErrorMessage pattern: known ProposalErrors surface their
// own safe message, anything else collapses to a generic message so internals never leak.
// request_id (when passed) is echoed back so a salesperson can report a failure and it's
// traceable in logs - never anything more sensitive than the id itself.
function toErrorResponse(error, requestId) {
	if (error instanceof ProposalError) {
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
			error: { code: "PROCESSING_FAILED", message: "An unexpected error occurred." },
			request_id: requestId || null
		}
	};
}

module.exports = { ERROR_CODES, ProposalError, toErrorResponse };
