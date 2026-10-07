"use strict";

/**
 * Spikra Customer Solution Document Renderer
 *
 * Implements the approved Spikra Design System (fixed theme from approved Spikra
 * Commercial Proposal reference: Poppins & Inter typography, Spikra color tokens,
 * sticky top brand bar with 3-document switcher, client badge, sticky anchor navigation,
 * deliverable cards, phased roadmap, and governance/commercials).
 *
 * Provides three separate logical templates:
 * 1. Technical Template (Architecture, Systems, Tech Requirements, Integrations, Deliverables)
 * 2. Commercial Template (Commercial Scope, Deliverables Catalog, Milestones, Licensing & Pricing)
 * 3. TOS Template (Terms of Service, Scope Governance, SLAs, Hypercare, Assumptions, Sign-off)
 */

function escapeHtml(str) {
	return String(str == null ? "" : str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderBadgeList(items, emptyText) {
	const list = (Array.isArray(items) ? items : []).map((s) => String(s || "").trim()).filter(Boolean);
	if (list.length === 0) {
		return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
	}
	return `<div class="badge-wrap">${list.map((item) => `<span class="app-badge"><svg class="badge-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>${escapeHtml(item)}</span>`).join("")}</div>`;
}

function renderListItems(items, emptyText, itemClass = "") {
	const list = (Array.isArray(items) ? items : []).map((s) => String(s || "").trim()).filter(Boolean);
	if (list.length === 0) {
		return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
	}
	return `<ul class="styled-list ${itemClass}">${list.map((item) => `<li><span class="list-dot"></span><span>${escapeHtml(item)}</span></li>`).join("")}</ul>`;
}

// Two-column info table - matches the reference Spikra Commercial Proposal's dominant
// layout pattern ("Your requirement / How this proposal responds", "Work area / Key
// deliverables", "# Cost component / What it covers", etc.) rather than a card grid.
function renderSubsections(subsections) {
	if (!Array.isArray(subsections) || subsections.length === 0) return "";

	const rows = subsections.map((sub, i) => {
		const title = typeof sub === "object" ? (sub.title || sub.heading || `Item ${i + 1}`) : `Item ${i + 1}`;
		const content = typeof sub === "object" ? (sub.content || sub.description || "") : String(sub);
		return `
		<tr>
			<td class="info-table-key">${escapeHtml(title)}</td>
			<td class="info-table-val">${escapeHtml(content)}</td>
		</tr>`;
	}).join("");

	return `<table class="info-table"><tbody>${rows}</tbody></table>`;
}

function renderSharedDocumentTemplate({
	docType,
	docTitle,
	eyebrow,
	badgeLabel,
	accentColor,
	companyName,
	industry,
	generatedAt,
	proposalId,
	sections,
	options = {}
}) {
	const customerName = String(companyName || "Customer Organization").trim();
	const industryText = String(industry || "").trim();
	const safeDocTitle = escapeHtml(docTitle || `${customerName} — Solution Document`);
	const safeEyebrow = escapeHtml(eyebrow || "SPIKRA CUSTOMER PROPOSAL");
	const safeBadge = escapeHtml(badgeLabel || "Spikra Document");
	const safeProposalId = escapeHtml(String(proposalId || "Pending"));

	const generatedDate = generatedAt ? new Date(generatedAt) : new Date();
	const dateStr = isNaN(generatedDate.getTime())
		? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
		: generatedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const validSections = Array.isArray(sections) && sections.length > 0
		? sections
		: [{ heading: "Executive Summary", content: "Details to be finalized during alignment.", subsections: [] }];

	// Plain contents list (matches the reference proposal's own "Contents" page) - static
	// text, not a functional nav bar and not a document switcher.
	const contentsHtml = validSections.map((sec, idx) => {
		const headingText = sec.heading || `Section ${idx + 1}`;
		return `<li><span class="contents-num">${idx + 1}.</span><span>${escapeHtml(headingText)}</span></li>`;
	}).join("");

	// Sections content HTML - numbered heading, narrative paragraph, then a two-column
	// info table for any subsections (matches the reference document's table-driven layout).
	const sectionsHtml = validSections.map((sec, idx) => {
		const secId = `section-${idx + 1}`;
		const headingText = sec.heading || `Section ${idx + 1}`;
		const contentText = sec.content || "";

		return `
		<section class="doc-section" id="${secId}">
			<h2 class="section-title">${idx + 1}. ${escapeHtml(headingText)}</h2>
			${contentText ? `<p class="section-narrative">${escapeHtml(contentText)}</p>` : ""}
			${renderSubsections(sec.subsections)}
		</section>`;
	}).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeDocTitle} | Spikra</title>
<meta name="description" content="${escapeHtml(customerName)} — ${safeDocTitle} prepared by Spikra Solutions">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #14415A;
    --deep: #0C2C3E;
    --flame: #F4611F;
    --flame-2: #E8402E;
    --flame-soft: #FFF3EC;
    --sky: #2C7CB8;
    --paper: #F7F9FA;
    --card: #FFFFFF;
    --line: #E3E9ED;
    --muted: #6B7C87;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(12, 44, 62, .05), 0 8px 24px rgba(12, 44, 62, .06);
    --success: #10b981;
    --success-soft: #ecfdf5;
    --doc-accent: ${accentColor || "var(--flame)"};
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--paper);
    color: var(--ink);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  /* Diagonal brand banner - orange to deep-navy, matching the reference Spikra Commercial
     Proposal's cover header exactly. No tabs, no document switcher, no in-page nav links -
     just the brand mark, the document category, and an optional print action. */
  .top-diagonal-banner {
    background: linear-gradient(100deg, var(--flame) 0%, var(--flame-2) 46%, var(--deep) 54%, var(--deep) 100%);
    padding: 18px 32px;
  }
  .banner-inner {
    max-width: 960px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .banner-logo {
    font-family: 'Poppins', sans-serif;
    font-size: 21px;
    font-weight: 700;
    letter-spacing: 0.01em;
    color: #ffffff;
  }
  .banner-logo span { opacity: 0.85; }
  .banner-doctype {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #ffffff;
  }
  .banner-print-btn {
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    color: #ffffff;
    background: rgba(255, 255, 255, 0.16);
    border: 1px solid rgba(255, 255, 255, 0.45);
    padding: 5px 12px;
    border-radius: 7px;
    cursor: pointer;
  }
  .banner-print-btn:hover { background: rgba(255, 255, 255, 0.28); }

  /* Page container - single constrained column, matching a printed proposal's page width */
  .container {
    max-width: 960px;
    margin: 0 auto;
    padding: 48px 32px 56px;
  }

  /* Cover block - eyebrow, title, "prepared for / by", metadata table - all centered,
     mirroring the reference proposal's title page. */
  .cover-block {
    text-align: center;
    padding-bottom: 36px;
    margin-bottom: 40px;
    border-bottom: 1px solid var(--line);
  }
  .cover-eyebrow {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--doc-accent);
    margin-bottom: 10px;
  }
  .cover-title {
    font-family: 'Poppins', sans-serif;
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 700;
    color: var(--deep);
    letter-spacing: -0.01em;
    line-height: 1.15;
    margin-bottom: 18px;
  }
  .cover-rule {
    width: 64px;
    height: 3px;
    background: var(--doc-accent);
    margin: 0 auto 22px;
    border-radius: 2px;
  }
  .cover-prepared {
    font-size: 14px;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .cover-prepared strong {
    color: var(--deep);
    font-weight: 600;
  }
  .cover-meta-table {
    width: 100%;
    max-width: 560px;
    margin: 28px auto 0;
    border-collapse: collapse;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    text-align: left;
  }
  .cover-meta-table tr:nth-child(even) { background: var(--paper); }
  .cover-meta-table td {
    padding: 10px 16px;
    font-size: 13px;
    border-bottom: 1px solid var(--line);
  }
  .cover-meta-table tr:last-child td { border-bottom: none; }
  .cover-meta-key {
    font-weight: 600;
    color: var(--muted);
    width: 42%;
  }
  .cover-meta-val {
    color: var(--deep);
    font-weight: 500;
  }

  /* Static contents list - plain text, not a functional nav */
  .contents-block {
    margin-bottom: 40px;
  }
  .contents-heading {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: var(--deep);
    margin-bottom: 12px;
  }
  .contents-block ul {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .contents-block li {
    display: flex;
    gap: 10px;
    font-size: 13.5px;
    color: var(--ink);
  }
  .contents-num {
    font-weight: 700;
    color: var(--doc-accent);
    min-width: 20px;
  }

  /* Document sections - plain numbered headings, paragraph body, two-column info tables -
     matches the reference document's structure (no cards, no badges). */
  .doc-section {
    margin-bottom: 36px;
  }
  .section-title {
    font-family: 'Poppins', sans-serif;
    font-size: 19px;
    font-weight: 700;
    color: var(--deep);
    letter-spacing: -0.01em;
    padding-bottom: 10px;
    margin-bottom: 14px;
    border-bottom: 2px solid var(--doc-accent);
  }
  .section-narrative {
    font-size: 14.5px;
    color: var(--ink);
    margin-bottom: 18px;
    line-height: 1.7;
    white-space: pre-line;
  }

  /* Two-column info table */
  .info-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    margin-top: 8px;
  }
  .info-table tr:nth-child(even) { background: var(--paper); }
  .info-table td {
    padding: 11px 16px;
    font-size: 13.5px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .info-table tr:last-child td { border-bottom: none; }
  .info-table-key {
    font-weight: 600;
    color: var(--deep);
    width: 32%;
  }
  .info-table-val {
    color: var(--ink);
    line-height: 1.6;
    white-space: pre-line;
  }

  /* Sign-off Block */
  .signoff-box {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 28px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 28px 32px;
    margin-top: 32px;
  }
  .sign-col h5 {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--deep);
    margin-bottom: 28px;
  }
  .sign-line {
    border-top: 1px dashed var(--muted);
    padding-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  /* Footer */
  .proposal-footer {
    text-align: center;
    padding-top: 40px;
    color: var(--muted);
    font-size: 12px;
    border-top: 1px solid var(--line);
    margin-top: 48px;
  }

  .empty-note {
    color: var(--muted);
    font-style: italic;
    font-size: 13.5px;
  }

  @media (max-width: 768px) {
    .container { padding: 32px 18px 40px; }
    .signoff-box { grid-template-columns: 1fr; gap: 20px; }
  }

  @media print {
    .banner-print-btn { display: none !important; }
    body { background: #ffffff !important; }
    .container { max-width: 100% !important; padding: 0 !important; }
  }
</style>
</head>
<body>

<!-- Diagonal brand banner - no tabs, no document switcher, no links to the other documents -->
<header class="top-diagonal-banner">
  <div class="banner-inner">
    <div class="banner-logo">SPIKRA<span>.</span></div>
    <div class="banner-doctype">${safeBadge}</div>
    <button class="banner-print-btn" onclick="window.print()">Export / Print</button>
  </div>
</header>

<div class="container">

  <!-- Cover -->
  <section class="cover-block">
    <div class="cover-eyebrow">${safeEyebrow}</div>
    <h1 class="cover-title">${safeDocTitle}</h1>
    <div class="cover-rule"></div>
    <p class="cover-prepared">Prepared for <strong>${escapeHtml(customerName)}</strong>${industryText ? ` · ${escapeHtml(industryText)}` : ""}</p>
    <p class="cover-prepared">Prepared by <strong>Spikra — Zoho Premium Partner &amp; IT Consulting</strong></p>

    <table class="cover-meta-table">
      <tbody>
        <tr><td class="cover-meta-key">Document Reference</td><td class="cover-meta-val">${safeProposalId}</td></tr>
        <tr><td class="cover-meta-key">Date</td><td class="cover-meta-val">${dateStr}</td></tr>
        <tr><td class="cover-meta-key">Version</td><td class="cover-meta-val">Draft v1.0 — For Client Review</td></tr>
        <tr><td class="cover-meta-key">Basis Document</td><td class="cover-meta-val">Discovery documentation provided by ${escapeHtml(customerName)}</td></tr>
      </tbody>
    </table>
  </section>

  <!-- Contents (static text, matches the reference document's own Contents page) -->
  <section class="contents-block">
    <div class="contents-heading">Contents</div>
    <ul>${contentsHtml}</ul>
  </section>

  <!-- Content Sections -->
  ${sectionsHtml}

  <!-- Sign-off Block -->
  <div class="signoff-box">
    <div class="sign-col">
      <h5>Prepared by Spikra Solutions</h5>
      <div class="sign-line">Authorized Signatory · Spikra Solutions</div>
    </div>
    <div class="sign-col">
      <h5>Accepted by Customer</h5>
      <div class="sign-line">Authorized Signatory · ${escapeHtml(customerName)}</div>
    </div>
  </div>

  <!-- Footer -->
  <footer class="proposal-footer">
    <p>Confidential — ${safeBadge} for ${escapeHtml(customerName)}</p>
    <p style="margin-top: 4px; font-size: 11px;">Spikra — Zoho Premium Partner · sales@spikra.com</p>
  </footer>

</div>

</body>
</html>`;
}

/**
 * 1. Technical Document Template
 * Focuses on Technical Architecture, Requirements, Systems, Integrations, and Technical Deliverables.
 */
function unwrapDocumentData(inputData) {
	if (!inputData || typeof inputData !== "object") return { data: {}, proposalId: null, customerName: null, industry: null };
	const docObj = (inputData.content && typeof inputData.content === "object") ? inputData.content : inputData;
	const proposalId = inputData.proposal_id || (inputData.content && inputData.content.proposal_id) || null;
	const customerName = inputData.customer_name || (docObj.customer && docObj.customer.company_name) || (inputData.customer && inputData.customer.company_name) || null;
	const industry = inputData.industry || (docObj.customer && docObj.customer.industry) || (inputData.customer && inputData.customer.industry) || null;
	return { data: docObj, proposalId, customerName, industry };
}

/**
 * 1. Technical Document Template
 * Focuses on Technical Specifications, Architecture, Integrations, and Security.
 */
function renderTechnicalDocument(technicalData, options = {}) {
	const unwrapped = unwrapDocumentData(technicalData);
	const data = unwrapped.data;
	const customerName = options.customerName || unwrapped.customerName || "Customer Organization";
	const industry = options.industry || unwrapped.industry || "";
	const proposalId = options.proposalId || unwrapped.proposalId;
	const title = data.title || (technicalData && technicalData.title) || `${customerName} — Technical Specification`;
	const sections = data.sections || (technicalData && technicalData.sections) || [];

	return renderSharedDocumentTemplate({
		docType: "technical",
		docTitle: title,
		eyebrow: "SPIKRA SOLUTIONS · TECHNICAL SPECIFICATION & ARCHITECTURE",
		badgeLabel: "Technical Document",
		accentColor: "var(--sky)",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections,
		options
	});
}

/**
 * 2. Commercial Document Template
 * Reference: Approved Spikra Commercial Proposal (iSteel_Proposal_Site.html)
 * Focuses on Commercial Scope, Deliverables Catalog, Milestones, Licensing & Pricing.
 */
function renderCommercialDocument(commercialData, options = {}) {
	const unwrapped = unwrapDocumentData(commercialData);
	const data = unwrapped.data;
	const customerName = options.customerName || unwrapped.customerName || "Customer Organization";
	const industry = options.industry || unwrapped.industry || "";
	const proposalId = options.proposalId || unwrapped.proposalId;
	const title = data.title || (commercialData && commercialData.title) || `${customerName} — Commercial Proposal`;
	const sections = data.sections || (commercialData && commercialData.sections) || [];

	return renderSharedDocumentTemplate({
		docType: "commercial",
		docTitle: title,
		eyebrow: "SPIKRA SOLUTIONS · COMMERCIAL PROPOSAL",
		badgeLabel: "Commercial Proposal",
		accentColor: "var(--flame)",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections,
		options
	});
}

/**
 * 3. TOS Document Template
 * Focuses on Terms of Service, Scope Governance, Assumptions, Dependencies, Risks, SLA & Hypercare.
 */
function renderTosDocument(tosData, options = {}) {
	const unwrapped = unwrapDocumentData(tosData);
	const data = unwrapped.data;
	const customerName = options.customerName || unwrapped.customerName || "Customer Organization";
	const industry = options.industry || unwrapped.industry || "";
	const proposalId = options.proposalId || unwrapped.proposalId;
	const title = data.title || (tosData && tosData.title) || `${customerName} — Terms of Service & SLA`;
	const sections = data.sections || (tosData && tosData.sections) || [];

	return renderSharedDocumentTemplate({
		docType: "tos",
		docTitle: title,
		eyebrow: "SPIKRA SOLUTIONS · TERMS OF SERVICE & SLA",
		badgeLabel: "TOS Document",
		accentColor: "var(--ink)",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections,
		options
	});
}

/**
 * Renders all three documents and returns an object:
 * { technical: html, commercial: html, tos: html }
 */
function renderAllDocuments(threeDocOutputs, options = {}) {
	const customerName = options.customerName || (threeDocOutputs && threeDocOutputs.customer && threeDocOutputs.customer.company_name) || "Customer Organization";
	const industry = options.industry || (threeDocOutputs && threeDocOutputs.customer && threeDocOutputs.customer.industry) || "";
	const mergedOptions = { ...options, customerName, industry };

	const technicalData = (threeDocOutputs && (threeDocOutputs.technical_document || threeDocOutputs.technical_json || threeDocOutputs.technical)) || threeDocOutputs;
	const commercialData = (threeDocOutputs && (threeDocOutputs.commercial_document || threeDocOutputs.commercial_json || threeDocOutputs.commercial)) || threeDocOutputs;
	const tosData = (threeDocOutputs && (threeDocOutputs.tos_document || threeDocOutputs.tos_json || threeDocOutputs.tos)) || threeDocOutputs;

	return {
		technical: renderTechnicalDocument(technicalData, mergedOptions),
		commercial: renderCommercialDocument(commercialData, mergedOptions),
		tos: renderTosDocument(tosData, mergedOptions)
	};
}

/**
 * Backward compatibility wrapper: renders the commercial proposal document
 * (or technical / tos if options.docType is explicitly requested).
 */
function renderProposalDocument(data, options = {}) {
	const docType = String(options.docType || "commercial").toLowerCase();
	if (docType === "technical") {
		return renderTechnicalDocument(data && data.technical_document ? data.technical_document : data, options);
	}
	if (docType === "tos") {
		return renderTosDocument(data && data.tos_document ? data.tos_document : data, options);
	}
	return renderCommercialDocument(data && data.commercial_document ? data.commercial_document : data, options);
}

module.exports = {
	renderTechnicalDocument,
	renderCommercialDocument,
	renderTosDocument,
	renderAllDocuments,
	renderProposalDocument
};
