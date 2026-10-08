"use strict";

/**
 * Spikra Customer Solution Document Renderer
 *
 * Visual theme matches the approved Spikra Commercial Proposal reference template
 * (Commercial-template.html, stored verbatim at docs/reference-templates/ in this repo):
 * same colors (blue #1F4E79 / orange #F26522), same typography (Carlito/Calibri body,
 * Georgia/Caladea headings), same diagonal orange-to-blue topbar with the real Spikra
 * logo artwork, same cover-page layout, same Contents page, same table styling, same
 * footer wording.
 *
 * Unlike the reference file (which binds content to fixed, Commercial-specific section
 * IDs - pricing, payment schedule, licensing, "Why Spikra"), this renderer displays
 * whatever sections the Zia Agent actually returns, under their own real titles, for all
 * three document types. That's deliberate: Technical and TOS documents have completely
 * different sections than Commercial, and forcing their content into Commercial-only
 * slots would either fabricate "To be confirmed" placeholders over real content or
 * silently drop content that doesn't match a hardcoded section name - exactly what must
 * not happen per the "ground everything in the uploaded documents, never invent" rule
 * that governs all three documents.
 */

const { HEADER_LOGO_DATA_URI, COVER_LOGO_DATA_URI } = require("./logos");

function escapeHtml(str) {
	return String(str == null ? "" : str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Two-column info table - matches the reference template's dominant layout pattern
// ("Your requirement / How this proposal responds", "Work area / Key deliverables", etc.)
// Generic "Topic / Details" header since subsections aren't tied to one fixed meaning
// across Technical, Commercial and TOS documents the way the reference's named columns are.
function renderSubsections(subsections) {
	if (!Array.isArray(subsections) || subsections.length === 0) return "";

	const rows = subsections.map((sub, i) => {
		const title = typeof sub === "object" ? (sub.title || sub.heading || `Item ${i + 1}`) : `Item ${i + 1}`;
		const content = typeof sub === "object" ? (sub.content || sub.description || "") : String(sub);
		return `<tr><td class="info-key">${escapeHtml(title)}</td><td class="info-val">${escapeHtml(content)}</td></tr>`;
	}).join("");

	return `<table class="data"><thead><tr><th>Topic</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSharedDocumentTemplate({
	docTitle,
	kicker,
	badgeLabel,
	companyName,
	industry,
	generatedAt,
	proposalId,
	sections
}) {
	const customerName = String(companyName || "Customer Organization").trim();
	const industryText = String(industry || "").trim();
	const safeDocTitle = escapeHtml(docTitle || `${customerName} — Solution Document`);
	const safeKicker = escapeHtml(kicker || "SPIKRA PROPOSAL");
	const safeBadge = escapeHtml(badgeLabel || "Spikra Document");
	const safeProposalId = escapeHtml(String(proposalId || "Pending"));

	const generatedDate = generatedAt ? new Date(generatedAt) : new Date();
	const dateStr = isNaN(generatedDate.getTime())
		? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
		: generatedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const validSections = Array.isArray(sections) && sections.length > 0
		? sections
		: [{ heading: "Summary", content: "No content was found in the uploaded documents for this section.", subsections: [] }];

	// Plain contents list (matches the reference template's own Contents page) - static
	// text, not a functional nav bar and not a document switcher.
	const contentsHtml = validSections.map((sec, idx) => {
		const headingText = sec.heading || `Section ${idx + 1}`;
		return `<div class="toc-row"><span>${idx + 1}. ${escapeHtml(headingText)}</span><span class="toc-dots"></span></div>`;
	}).join("");

	const sectionsHtml = validSections.map((sec, idx) => {
		const headingText = sec.heading || `Section ${idx + 1}`;
		const contentText = sec.content || "";
		return `
		<section class="doc-section">
			<h2 class="section-title">${idx + 1}. ${escapeHtml(headingText)}</h2>
			${contentText ? `<p>${escapeHtml(contentText)}</p>` : ""}
			${renderSubsections(sec.subsections)}
		</section>`;
	}).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeDocTitle} | Spikra</title>
<meta name="description" content="${escapeHtml(customerName)} — ${safeDocTitle} prepared by Spikra">
<style>
  /* =========================================================
     Theme copied from the approved Spikra Commercial Proposal
     reference template (docs/reference-templates/commercial-template.html)
  ========================================================= */
  :root {
    --spikra-blue: #1F4E79;
    --spikra-orange: #F26522;
    --spikra-light: #EEF3F8;
    --spikra-border: #D7E0E8;
    --text: #202020;
    --muted: #666666;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body { background: #f3f3f3; }

  body {
    font-family: "Carlito", "Calibri", Arial, sans-serif;
    color: var(--text);
    font-size: 15px;
    line-height: 1.55;
  }

  h1, h2, h3 { font-family: "Caladea", Georgia, "Times New Roman", serif; }

  /* ---------- Diagonal topbar (orange / blue split) - identical construction to the
     reference template: a 40%-width orange block with a skewed trailing edge, flush
     against a flex-fill blue block. ---------- */
  .topbar { height: 54px; width: 100%; position: relative; display: flex; overflow: hidden; }
  .topbar .orange {
    width: 40%;
    background: var(--spikra-orange);
    position: relative;
    display: flex;
    align-items: center;
    padding-left: 28px;
  }
  .topbar .orange::after {
    content: "";
    position: absolute;
    top: 0;
    right: -32px;
    width: 64px;
    height: 100%;
    background: var(--spikra-orange);
    transform: skewX(-29deg);
    transform-origin: top;
  }
  .topbar .blue {
    flex: 1;
    background: var(--spikra-blue);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 28px;
  }
  .topbar-logo { position: relative; z-index: 2; height: 26px; width: auto; object-fit: contain; }
  .topbar-title {
    position: relative;
    z-index: 3;
    color: #fff;
    font-family: Arial, sans-serif;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .page-shell { max-width: 820px; margin: 0 auto; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .content-pad { padding: 44px 48px 56px; }

  /* ---------- Cover ---------- */
  .cover-body { text-align: center; padding-bottom: 8px; }
  .cover-logo { width: 70px; height: 55px; object-fit: contain; margin: 0 auto 12px; display: block; }
  .cover-kicker {
    color: var(--spikra-orange);
    font-family: Arial, sans-serif;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1.8px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .cover-title { color: var(--spikra-blue); font-size: 28px; line-height: 1.15; font-weight: 700; margin-bottom: 18px; }
  .orange-rule { height: 2px; width: 70px; background: var(--spikra-orange); margin: 0 auto 26px; }
  .prepared-label { color: #777; font-size: 11px; margin-bottom: 3px; }
  .prepared-name { color: var(--spikra-blue); font-family: Georgia, serif; font-size: 15px; font-weight: 700; margin-bottom: 15px; }

  .cover-context {
    text-align: left;
    margin: 20px 0 16px;
    padding: 13px 16px;
    border-left: 4px solid var(--spikra-orange);
    background: var(--spikra-light);
    color: #3d4b57;
    font-size: 13.5px;
    line-height: 1.55;
  }

  .cover-meta { width: 100%; max-width: 560px; margin: 24px auto 0; border-collapse: collapse; text-align: left; font-size: 13px; }
  .cover-meta td { border: 1px solid var(--spikra-border); padding: 8px 12px; vertical-align: top; }
  .cover-meta td:first-child { width: 36%; background: var(--spikra-light); color: #46627a; font-weight: 700; }

  /* ---------- Contents ---------- */
  .toc-block { margin: 36px 0; padding-top: 28px; border-top: 1px solid var(--spikra-border); }
  .toc-block h2 { color: var(--spikra-blue); font-size: 18px; margin-bottom: 16px; }
  .toc-row { display: flex; align-items: baseline; gap: 8px; color: var(--spikra-blue); font-weight: 700; font-size: 14px; margin: 9px 0; }
  .toc-dots { flex: 1; border-bottom: 1px dotted #999; height: 1px; }

  /* ---------- Sections ---------- */
  .doc-section { margin: 30px 0; }
  .section-title {
    color: var(--spikra-blue);
    font-size: 18px;
    font-weight: 700;
    border-bottom: 2px solid var(--spikra-orange);
    padding-bottom: 8px;
    margin-bottom: 14px;
  }
  .doc-section p { margin-bottom: 12px; line-height: 1.65; white-space: pre-line; }

  /* ---------- Tables ---------- */
  table.data { width: 100%; border-collapse: collapse; margin: 10px 0 6px; font-size: 13.5px; }
  .data th { background: var(--spikra-blue); color: #fff; text-align: left; font-weight: 700; padding: 9px 12px; border: 1px solid var(--spikra-blue); }
  .data td { border: 1px solid var(--spikra-border); padding: 9px 12px; vertical-align: top; }
  .data tbody tr:nth-child(even) td { background: #F2F5F8; }
  .info-key { font-weight: 700; color: var(--spikra-blue); width: 30%; }
  .info-val { white-space: pre-line; }

  .empty-note { color: var(--muted); font-style: italic; font-size: 13.5px; }

  /* ---------- Sign-off ---------- */
  .signoff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; margin-top: 40px; }
  .signoff-name { color: var(--spikra-blue); font-weight: 700; margin-bottom: 22px; }
  .signoff-line { border-top: 1px solid #888; margin-bottom: 6px; }
  .signoff-caption { font-size: 11px; color: #666; margin-bottom: 16px; }

  /* ---------- Footer ---------- */
  .doc-footer {
    text-align: center;
    padding-top: 22px;
    margin-top: 40px;
    border-top: 1px solid var(--spikra-border);
    color: #666;
    font-size: 12px;
  }
  .doc-footer .brand { color: var(--spikra-blue); font-weight: 700; }

  @media print {
    html, body { background: #fff; }
    .page-shell { max-width: 100%; box-shadow: none; }
  }

  @media (max-width: 640px) {
    .content-pad { padding: 28px 18px 36px; }
    .signoff-grid { grid-template-columns: 1fr; gap: 24px; }
  }
</style>
</head>
<body>

<div class="page-shell">

  <header class="topbar">
    <div class="orange"><img class="topbar-logo" src="${HEADER_LOGO_DATA_URI}" alt="Spikra"></div>
    <div class="blue"><div class="topbar-title">${safeBadge}</div></div>
  </header>

  <div class="content-pad">

    <!-- Cover -->
    <section class="cover-body">
      <img class="cover-logo" src="${COVER_LOGO_DATA_URI}" alt="Spikra">
      <div class="cover-kicker">${safeKicker}</div>
      <h1 class="cover-title">${safeDocTitle}</h1>
      <div class="orange-rule"></div>
      <div class="prepared-label">Prepared for</div>
      <div class="prepared-name">${escapeHtml(customerName)}${industryText ? ` <span style="color:#777;font-weight:400;font-size:12px;">(${escapeHtml(industryText)})</span>` : ""}</div>
      <div class="prepared-label">Prepared by</div>
      <div class="prepared-name">Spikra — Zoho Premium Partner &amp; IT Consulting</div>

      <table class="cover-meta">
        <tbody>
          <tr><td>Document Reference</td><td>${safeProposalId}</td></tr>
          <tr><td>Date</td><td>${dateStr}</td></tr>
          <tr><td>Version</td><td>Draft v1.0 — For Client Review</td></tr>
          <tr><td>Basis Document</td><td>Discovery documentation provided by ${escapeHtml(customerName)}</td></tr>
        </tbody>
      </table>
    </section>

    <!-- Contents (static text, matches the reference template's own Contents page) -->
    <section class="toc-block">
      <h2>Contents</h2>
      ${contentsHtml}
    </section>

    <!-- Content Sections -->
    ${sectionsHtml}

    <!-- Sign-off -->
    <div class="signoff-grid">
      <div>
        <div class="signoff-name">For ${escapeHtml(customerName)}</div>
        <div class="signoff-line"></div><div class="signoff-caption">Name / Designation</div>
        <div class="signoff-line"></div><div class="signoff-caption">Signature &amp; Date</div>
      </div>
      <div>
        <div class="signoff-name">For Spikra</div>
        <div class="signoff-line"></div><div class="signoff-caption">Name / Designation</div>
        <div class="signoff-line"></div><div class="signoff-caption">Signature &amp; Date</div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="doc-footer">
      <p>Confidential — ${safeBadge} for ${escapeHtml(customerName)}</p>
      <p style="margin-top: 4px;"><span class="brand">Spikra</span> — Zoho Premium Partner · sales@spikra.com</p>
    </footer>

  </div>
</div>

</body>
</html>`;
}

/**
 * Unwraps whatever shape a single-document payload arrives in (direct {title,sections},
 * or the wider proposal/content envelope) into a flat {title, sections, proposalId,
 * customerName, industry} record.
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
 * 1. Technical Document
 * Only technical content from the uploaded documents: architecture, systems, functional &
 * technical requirements, integrations, technical deliverables - whatever sections the
 * Agent actually produced, under their own titles.
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
		docTitle: title,
		kicker: "Technical Document",
		badgeLabel: "Technical Document",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections
	});
}

/**
 * 2. Commercial Document
 * Only commercial content from the uploaded documents: scope, deliverables, timeline,
 * pricing/licensing/payment terms - whatever sections the Agent actually produced.
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
		docTitle: title,
		kicker: "Commercial Proposal",
		badgeLabel: "Commercial Proposal",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections
	});
}

/**
 * 3. TOS Document
 * Only terms-of-service content from the uploaded documents: scope governance,
 * assumptions, dependencies, SLA & support - whatever sections the Agent actually produced.
 */
function renderTosDocument(tosData, options = {}) {
	const unwrapped = unwrapDocumentData(tosData);
	const data = unwrapped.data;
	const customerName = options.customerName || unwrapped.customerName || "Customer Organization";
	const industry = options.industry || unwrapped.industry || "";
	const proposalId = options.proposalId || unwrapped.proposalId;
	const title = data.title || (tosData && tosData.title) || `${customerName} — Terms of Service`;
	const sections = data.sections || (tosData && tosData.sections) || [];

	return renderSharedDocumentTemplate({
		docTitle: title,
		kicker: "Terms of Service",
		badgeLabel: "TOS Document",
		companyName: customerName,
		industry,
		generatedAt: options.generatedAt,
		proposalId,
		sections
	});
}

/**
 * Renders all three documents and returns { technical: html, commercial: html, tos: html }.
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
