"use strict";

// Polyfill DOMMatrix for environments where it is not available in Node
if (typeof globalThis.DOMMatrix === "undefined") {
	globalThis.DOMMatrix = class DOMMatrix {
		constructor() {
			this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
		}
	};
}

// Extraction + normalization for discovery package files. PDF and DOCX reuse the exact
// engine chain already proven in functions/spikra_document_process/index.js (Workspace 1) -
// not reimplemented, just generalized into a router. XLSX is new for Workspace 2.
//
// Raw audio/video (meeting recordings) are intentionally NOT transcribed here - see the
// plan's assumption 2. They're reported as UNSUPPORTED_FILE_TYPE with a clear message.

const path = require("path");
const mammoth = require("mammoth");
const PDFParser = require("pdf2json");
const XLSX = require("xlsx");
const { ProposalError } = require("../../utils/errors");

let pdfParse = null;
function getPdfParse() {
	if (!pdfParse) {
		if (typeof globalThis.DOMMatrix === "undefined") {
			globalThis.DOMMatrix = class DOMMatrix {
				constructor() {
					this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
				}
			};
		}
		pdfParse = require("pdf-parse");
	}
	return pdfParse;
}

const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".txt", ".csv", ".md"];

function getFileKind(fileName, mimeType) {
	const ext = path.extname(String(fileName || "")).toLowerCase();
	if (ext === ".pdf") return "PDF";
	if (ext === ".docx" || ext === ".doc") return "WORD";
	if (ext === ".xlsx" || ext === ".xls") return "EXCEL";
	if (ext === ".txt" || ext === ".csv" || ext === ".md") return "TEXT";

	const mime = String(mimeType || "").toLowerCase();
	if (mime.includes("pdf")) return "PDF";
	if (mime.includes("wordprocessingml") || mime.includes("msword")) return "WORD";
	if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || mime.includes("csv")) return "TEXT";
	if (mime.startsWith("text/")) return "TEXT";

	return null;
}

async function extractContent(buffer, { fileName, mimeType }) {
	if (!buffer || buffer.length === 0) {
		throw new ProposalError("EMPTY_FILE", `'${fileName}' has no content.`);
	}

	const kind = getFileKind(fileName, mimeType);
	if (!kind) {
		throw new ProposalError(
			"UNSUPPORTED_FILE_TYPE",
			`'${fileName}' is not a supported file type. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`
		);
	}

	let rawText;
	try {
		if (kind === "PDF") {
			validatePdfSignature(buffer, fileName);
			rawText = await extractPdfText(buffer);
		} else if (kind === "WORD") {
			rawText = await extractWordText(buffer);
		} else if (kind === "EXCEL") {
			rawText = extractExcelText(buffer);
		} else {
			rawText = buffer.toString("utf8");
		}
	} catch (err) {
		if (err instanceof ProposalError) throw err;
		throw new ProposalError("EXTRACTION_FAILED", `Failed to extract content from '${fileName}': ${err.message}`);
	}

	const normalized = normalizeText(rawText);
	if (!normalized) {
		throw new ProposalError("EMPTY_FILE", `No extractable text found in '${fileName}'.`);
	}

	return { kind, text: normalized };
}

function validatePdfSignature(buffer, fileName) {
	const signature = buffer.subarray(0, 5).toString("ascii");
	if (signature !== "%PDF-") {
		throw new ProposalError("UNSUPPORTED_FILE_TYPE", `'${fileName}' does not appear to be a valid PDF.`);
	}
}

// Same three-engine chain as Workspace 1, same reason: pdfjs-dist must run first because
// pdf-parse and pdf2json both fail outright on PDFs with compressed xref/object streams.
async function extractPdfText(pdfBuffer) {
	const attempts = [];

	try {
		const text = await extractTextWithPdfJs(pdfBuffer);
		if (text && text.trim()) return text;
		attempts.push({ engine: "pdfjs-dist", error: null });
	} catch (e) {
		attempts.push({ engine: "pdfjs-dist", error: e });
	}

	try {
		const parse = getPdfParse();
		const parsed = await parse(pdfBuffer);
		if (parsed && parsed.text && parsed.text.trim()) return parsed.text;
		attempts.push({ engine: "pdf-parse", error: null });
	} catch (e) {
		attempts.push({ engine: "pdf-parse", error: e });
	}

	try {
		const fallbackText = await extractTextWithPdf2Json(pdfBuffer);
		if (fallbackText && fallbackText.trim()) return fallbackText;
		attempts.push({ engine: "pdf2json", error: null });
	} catch (e) {
		attempts.push({ engine: "pdf2json", error: e });
	}

	const pdfjsError = attempts.find((a) => a.engine === "pdfjs-dist" && a.error)?.error;
	if (pdfjsError && pdfjsError.name === "PasswordException") {
		throw new ProposalError("EXTRACTION_FAILED", "This PDF is password-protected.");
	}
	if (pdfjsError && pdfjsError.name === "InvalidPDFException") {
		throw new ProposalError("EXTRACTION_FAILED", "The PDF file appears to be corrupted or invalid.");
	}
	throw new ProposalError("EXTRACTION_FAILED", "No extractable text found - it may be a scanned or image-only PDF.");
}

async function extractTextWithPdfJs(pdfBuffer) {
	if (typeof Promise.withResolvers !== "function") {
		Promise.withResolvers = function withResolvers() {
			let resolve, reject;
			const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
			return { promise, resolve, reject };
		};
	}

	const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(pdfBuffer),
		useWorkerFetch: false,
		isEvalSupported: false,
		disableFontFace: true
	});
	const doc = await loadingTask.promise;

	try {
		const pageTexts = [];
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const content = await page.getTextContent();
			pageTexts.push(content.items.map((item) => item.str || "").join(" "));
		}
		return pageTexts.join("\n");
	} finally {
		if (typeof doc.cleanup === "function") await doc.cleanup();
		if (typeof loadingTask.destroy === "function") await loadingTask.destroy();
	}
}

function extractTextWithPdf2Json(pdfBuffer) {
	return new Promise((resolve, reject) => {
		const parser = new PDFParser();
		parser.on("pdfParser_dataError", (errData) => {
			reject(new Error((errData && errData.parserError && errData.parserError.message) || "pdf2json parse error"));
		});
		parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
		parser.parseBuffer(pdfBuffer);
	});
}

async function extractWordText(wordBuffer) {
	const result = await mammoth.extractRawText({ buffer: wordBuffer });
	return (result && result.value) || "";
}

// Each sheet becomes a labeled CSV block - a plain, readable text representation an LLM
// can read directly, without needing to understand a binary spreadsheet format.
function extractExcelText(buffer) {
	const workbook = XLSX.read(buffer, { type: "buffer" });
	const blocks = workbook.SheetNames.map((sheetName) => {
		const sheet = workbook.Sheets[sheetName];
		const csv = XLSX.utils.sheet_to_csv(sheet).trim();
		return csv ? `Sheet: ${sheetName}\n${csv}` : "";
	}).filter(Boolean);
	return blocks.join("\n\n");
}

function normalizeText(text) {
	return String(text || "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

module.exports = { extractContent, getFileKind, SUPPORTED_EXTENSIONS };
