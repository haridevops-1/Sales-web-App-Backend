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

/**
 * Combines all extracted information from one or multiple customer discovery documents
 * into one consolidated structured customer JSON.
 *
 * Schema:
 * {
 *   customer: { company_name, industry, business_context },
 *   business_context: { overview, current_state, strategic_drivers },
 *   goals: [],
 *   requirements: [],
 *   processes: [],
 *   challenges: [],
 *   technical_requirements: [],
 *   integrations: [],
 *   commercial_information: { budget, pricing_notes, payment_terms, licensing },
 *   timeline_information: [],
 *   deliverables: [],
 *   assumptions: [],
 *   dependencies: [],
 *   risks: [],
 *   tos_information: { sla, support_terms, governance },
 *   source_documents: []
 * }
 */
function consolidateExtractedDocuments(extractedDocs, { sessionName = "", businessName = "" } = {}) {
	if (!Array.isArray(extractedDocs) || extractedDocs.length === 0) {
		throw new ProposalError("VALIDATION_FAILED", "No extracted documents provided for consolidation.");
	}

	const cleanSessionName = String(businessName || sessionName || "")
		.replace(/\.(pdf|docx|doc|xlsx|xls|txt|csv|md)$/i, "")
		.trim();

	const consolidated = {
		customer: {
			company_name: cleanSessionName || "Customer Organization",
			industry: "",
			business_context: ""
		},
		business_context: {
			overview: "",
			current_state: "",
			strategic_drivers: []
		},
		goals: [],
		requirements: [],
		processes: [],
		challenges: [],
		technical_requirements: [],
		integrations: [],
		commercial_information: {
			budget: null,
			pricing_notes: null,
			payment_terms: null,
			licensing: null
		},
		timeline_information: [],
		deliverables: [],
		assumptions: [],
		dependencies: [],
		risks: [],
		tos_information: {
			sla: null,
			support_terms: null,
			governance: null
		},
		source_documents: []
	};

	const sourceBlocks = [];
	const detectedCustomerNames = new Set();
	const detectedIndustries = new Set();

	for (const doc of extractedDocs) {
		const fileName = doc.file_name || "Document";
		const fileType = doc.file_type || doc.kind || "TEXT";
		const text = String(doc.text || "").trim();

		sourceBlocks.push(`=== Source: ${fileName} (${fileType}) ===\n${text}`);
		consolidated.source_documents.push({
			file_name: fileName,
			file_type: fileType,
			character_count: text.length
		});

		// Parse lines and sections from this document
		parseDocumentContentIntoConsolidated(text, fileName, consolidated, {
			detectedCustomerNames,
			detectedIndustries
		});
	}

	// Refine company_name if detected from documents
	if (detectedCustomerNames.size > 0) {
		const firstFound = Array.from(detectedCustomerNames)[0];
		if (firstFound && firstFound !== "Customer Organization") {
			consolidated.customer.company_name = firstFound;
		}
	}
	if (detectedIndustries.size > 0 && !consolidated.customer.industry) {
		consolidated.customer.industry = Array.from(detectedIndustries)[0];
	}

	// Keep customer.business_context in sync with business_context.overview
	if (!consolidated.customer.business_context && consolidated.business_context.overview) {
		consolidated.customer.business_context = consolidated.business_context.overview;
	} else if (consolidated.customer.business_context && !consolidated.business_context.overview) {
		consolidated.business_context.overview = consolidated.customer.business_context;
	}

	// Remove duplicate items in array fields
	consolidated.goals = dedupeStrings(consolidated.goals);
	consolidated.requirements = dedupeStrings(consolidated.requirements);
	consolidated.processes = dedupeStrings(consolidated.processes);
	consolidated.challenges = dedupeStrings(consolidated.challenges);
	consolidated.technical_requirements = dedupeStrings(consolidated.technical_requirements);
	consolidated.integrations = dedupeStrings(consolidated.integrations);
	consolidated.timeline_information = dedupeStrings(consolidated.timeline_information);
	consolidated.deliverables = dedupeStrings(consolidated.deliverables);
	consolidated.assumptions = dedupeStrings(consolidated.assumptions);
	consolidated.dependencies = dedupeStrings(consolidated.dependencies);
	consolidated.risks = dedupeStrings(consolidated.risks);

	// If requirements are empty but text exists, extract meaningful paragraphs
	if (consolidated.requirements.length === 0 && extractedDocs[0] && extractedDocs[0].text) {
		const paragraphs = extractedDocs[0].text
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter((p) => p.length > 30 && p.length < 500);
		if (paragraphs.length > 0) {
			consolidated.requirements = paragraphs.slice(0, 8);
		}
	}

	return {
		consolidated_json: consolidated,
		source_blocks: sourceBlocks,
		consolidated_text: sourceBlocks.join("\n\n")
	};
}

function parseDocumentContentIntoConsolidated(text, fileName, consolidated, { detectedCustomerNames, detectedIndustries }) {
	const lines = text.split("\n");
	let currentSection = null;
	const sectionBuffer = [];

	function flushSection() {
		if (!currentSection || sectionBuffer.length === 0) {
			sectionBuffer.length = 0;
			return;
		}
		const sectionText = sectionBuffer.join("\n").trim();
		const items = sectionText
			.split(/\n+/)
			.map((l) => l.replace(/^[-*•\d.)\]\s]+/, "").trim())
			.filter((l) => l.length > 5);

		switch (currentSection) {
			case "goals":
				consolidated.goals.push(...items);
				break;
			case "requirements":
				consolidated.requirements.push(...items);
				break;
			case "technical_requirements":
				consolidated.technical_requirements.push(...items);
				break;
			case "processes":
				consolidated.processes.push(...items);
				break;
			case "challenges":
				consolidated.challenges.push(...items);
				break;
			case "integrations":
				consolidated.integrations.push(...items);
				break;
			case "deliverables":
				consolidated.deliverables.push(...items);
				break;
			case "timeline_information":
				consolidated.timeline_information.push(...items);
				break;
			case "assumptions":
				consolidated.assumptions.push(...items);
				break;
			case "dependencies":
				consolidated.dependencies.push(...items);
				break;
			case "risks":
				consolidated.risks.push(...items);
				break;
			case "commercial":
				if (!consolidated.commercial_information.pricing_notes) {
					consolidated.commercial_information.pricing_notes = sectionText.slice(0, 1000);
				}
				break;
			case "tos":
				if (!consolidated.tos_information.support_terms) {
					consolidated.tos_information.support_terms = sectionText.slice(0, 1000);
				}
				break;
			case "overview":
				if (!consolidated.business_context.overview) {
					consolidated.business_context.overview = sectionText.slice(0, 1500);
				}
				break;
			default:
				break;
		}

		sectionBuffer.length = 0;
	}

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		// Check for key-value client metadata patterns
		const clientMatch = line.match(/^(?:Client|Customer|Company|Organization|Account)\s*:\s*(.+)$/i);
		if (clientMatch && clientMatch[1]) {
			const name = clientMatch[1].trim();
			if (name.length > 2 && name.length < 100) {
				detectedCustomerNames.add(name);
			}
		}

		const industryMatch = line.match(/^(?:Industry|Vertical|Sector|Business Domain)\s*:\s*(.+)$/i);
		if (industryMatch && industryMatch[1]) {
			const ind = industryMatch[1].trim();
			if (ind.length > 2 && ind.length < 80) {
				detectedIndustries.add(ind);
			}
		}

		// Detect section headers
		const cleanHeading = line.replace(/^[#*=_-\s]+|[#*=_-\s]+$/g, "").trim().toLowerCase();
		let matchedSection = null;

		if (/^(?:goals|objectives|business goals|key goals|desired outcomes|success metrics)/i.test(cleanHeading)) {
			matchedSection = "goals";
		} else if (/^(?:requirements|functional requirements|business requirements|key requirements|scope|feature requirements)/i.test(cleanHeading)) {
			matchedSection = "requirements";
		} else if (/^(?:technical requirements|architecture|tech stack|infrastructure|security|technical specifications)/i.test(cleanHeading)) {
			matchedSection = "technical_requirements";
		} else if (/^(?:existing process|current process|processes|workflow|workflows|as-is process|to-be process)/i.test(cleanHeading)) {
			matchedSection = "processes";
		} else if (/^(?:challenges|pain points|problems|current bottlenecks|issues|limitations)/i.test(cleanHeading)) {
			matchedSection = "challenges";
		} else if (/^(?:integrations|apis|connectors|third-party systems|legacy systems|integration requirements)/i.test(cleanHeading)) {
			matchedSection = "integrations";
		} else if (/^(?:deliverables|scope of work|key deliverables|deliverable catalog|work packages)/i.test(cleanHeading)) {
			matchedSection = "deliverables";
		} else if (/^(?:timeline|implementation milestones|roadmap|project schedule|phases|milestones)/i.test(cleanHeading)) {
			matchedSection = "timeline_information";
		} else if (/^(?:assumptions|prerequisites|project assumptions)/i.test(cleanHeading)) {
			matchedSection = "assumptions";
		} else if (/^(?:dependencies|customer dependencies|client responsibilities)/i.test(cleanHeading)) {
			matchedSection = "dependencies";
		} else if (/^(?:risks|constraints|risk mitigation)/i.test(cleanHeading)) {
			matchedSection = "risks";
		} else if (/^(?:commercial|pricing|budget|investment|licensing|payment terms)/i.test(cleanHeading)) {
			matchedSection = "commercial";
		} else if (/^(?:terms of service|tos|sla|service level agreement|governance|support & hypercare|warranty)/i.test(cleanHeading)) {
			matchedSection = "tos";
		} else if (/^(?:overview|background|executive summary|introduction|business context|about the project)/i.test(cleanHeading)) {
			matchedSection = "overview";
		}

		if (matchedSection) {
			flushSection();
			currentSection = matchedSection;
		} else if (currentSection) {
			sectionBuffer.push(line);
		} else {
			// If before any section, search for bullet points or general context
			if (/^[-*•]/.test(line)) {
				const item = line.replace(/^[-*•\s]+/, "").trim();
				if (item.length > 10) {
					consolidated.requirements.push(item);
				}
			} else if (!consolidated.business_context.overview && line.length > 40) {
				consolidated.business_context.overview = line;
			}
		}
	}

	flushSection();
}

function dedupeStrings(arr) {
	if (!Array.isArray(arr)) return [];
	const seen = new Set();
	const out = [];
	for (const item of arr) {
		const str = String(item || "").trim();
		if (str && !seen.has(str.toLowerCase())) {
			seen.add(str.toLowerCase());
			out.push(str);
		}
	}
	return out;
}

module.exports = {
	extractContent,
	getFileKind,
	SUPPORTED_EXTENSIONS,
	consolidateExtractedDocuments
};
