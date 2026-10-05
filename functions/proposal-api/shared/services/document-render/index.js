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

function renderSubsections(subsections) {
	if (!Array.isArray(subsections) || subsections.length === 0) return "";

	return `<div class="card-grid">${subsections.map((sub, i) => {
		const title = typeof sub === "object" ? (sub.title || sub.heading || `Item ${i + 1}`) : `Item ${i + 1}`;
		const content = typeof sub === "object" ? (sub.content || sub.description || "") : String(sub);
		const numStr = (i + 1 < 10 ? "0" : "") + (i + 1);

		return `
		<div class="deliverable-card">
			<div class="card-header">
				<div class="card-number">${numStr}</div>
				<h3 class="card-title">${escapeHtml(title)}</h3>
			</div>
			<div class="card-desc">${escapeHtml(content)}</div>
		</div>`;
	}).join("")}</div>`;
}

function buildDocumentSwitcherHtml(activeDocType, proposalId, options = {}) {
	const baseUrl = options.baseUrl || "";
	const buildUrl = (type) => {
		if (options.buildDocUrl && typeof options.buildDocUrl === "function") {
			return options.buildDocUrl(type);
		}
		if (proposalId) {
			return `${baseUrl}?proposal_id=${encodeURIComponent(proposalId)}&type=${type}`;
		}
		return `?type=${type}`;
	};

	const docs = [
		{ id: "technical", label: "Technical Document", icon: "M10 2a8 8 0 100 16 8 8 0 000-16zm1 11H9v-2h2v2zm0-4H9V5h2v4z" },
		{ id: "commercial", label: "Commercial Proposal", icon: "M4 4a2 2 0 012-2h8a2 2 0 012 2v12a1 1 0 110 2h-3a1 1 0 01-1-1v-2a1 1 0 00-1-1H9a1 1 0 00-1 1v2a1 1 0 01-1 1H4a1 1 0 110-2V4zm3 1h2v2H7V5zm2 4H7v2h2V9zm2-4h2v2h-2V5zm2 4h-2v2h2V9z" },
		{ id: "tos", label: "TOS Document", icon: "M9 2a1 1 0 000 2h2a1 1 0 100-2H9z M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5z" }
	];

	return `
	<div class="doc-switcher" role="tablist" aria-label="Document Type Switcher">
		${docs.map((d) => {
			const isActive = d.id === activeDocType;
			return `
			<a href="${buildUrl(d.id)}" class="doc-tab ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive}">
				<span class="tab-dot"></span>
				<span class="tab-label">${escapeHtml(d.label)}</span>
			</a>`;
		}).join("")}
	</div>`;
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

	const generatedDate = generatedAt ? new Date(generatedAt) : new Date();
	const dateStr = isNaN(generatedDate.getTime())
		? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
		: generatedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const validSections = Array.isArray(sections) && sections.length > 0
		? sections
		: [{ heading: "Executive Summary", content: "Details to be finalized during alignment.", subsections: [] }];

	// Dynamic sub-navigation links
	const navLinksHtml = validSections.map((sec, idx) => {
		const secId = `section-${idx + 1}`;
		const headingText = sec.heading || `Section ${idx + 1}`;
		return `<a href="#${secId}">${escapeHtml(headingText)}</a>`;
	}).join("");

	// Sections content HTML
	const sectionsHtml = validSections.map((sec, idx) => {
		const secId = `section-${idx + 1}`;
		const headingText = sec.heading || `Section ${idx + 1}`;
		const contentText = sec.content || "";
		const numStr = (idx + 1 < 10 ? "0" : "") + (idx + 1);

		return `
		<section class="proposal-section" id="${secId}">
			<div class="section-header">
				<div>
					<span class="section-number">${numStr}</span>
					<h2 class="section-title">${escapeHtml(headingText)}</h2>
				</div>
				<span class="section-badge">${safeBadge}</span>
			</div>
			${contentText ? `<div class="section-narrative">${escapeHtml(contentText)}</div>` : ""}
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

  /* Top Bar */
  .top-brand-bar {
    background: #ffffff;
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: 0 1px 3px rgba(12, 44, 62, 0.04);
  }
  .brand-bar-inner {
    max-width: 1140px;
    margin: 0 auto;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .brand-logo-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .spikra-brand-badge {
    font-family: 'Poppins', sans-serif;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--deep);
  }
  .spikra-brand-badge span { color: var(--flame); }
  .partner-tag {
    font-size: 11.5px;
    font-weight: 600;
    background: var(--flame-soft);
    color: var(--flame);
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(244, 97, 31, 0.2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Document Switcher */
  .doc-switcher {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--paper);
    padding: 4px;
    border-radius: 10px;
    border: 1px solid var(--line);
  }
  .doc-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--muted);
    text-decoration: none;
    border-radius: 7px;
    transition: all 0.15s ease;
  }
  .doc-tab:hover {
    color: var(--deep);
    background: rgba(255, 255, 255, 0.7);
  }
  .doc-tab.active {
    background: #ffffff;
    color: var(--deep);
    box-shadow: 0 1px 3px rgba(12, 44, 62, 0.08);
  }
  .doc-tab .tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line);
  }
  .doc-tab.active .tab-dot {
    background: var(--doc-accent);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .print-btn {
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--deep);
    background: #ffffff;
    border: 1px solid var(--line);
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .print-btn:hover {
    background: var(--paper);
    border-color: var(--muted);
  }

  /* Sticky Sub-Navigation */
  .sub-nav {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 57px;
    z-index: 90;
  }
  .sub-nav-inner {
    max-width: 1140px;
    margin: 0 auto;
    padding: 8px 24px;
    display: flex;
    gap: 20px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .sub-nav-inner::-webkit-scrollbar { display: none; }
  .sub-nav-inner a {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
    padding: 4px 0;
    border-bottom: 2px solid transparent;
    transition: all 0.15s ease;
  }
  .sub-nav-inner a:hover {
    color: var(--deep);
    border-color: var(--doc-accent);
  }

  /* Container */
  .container {
    max-width: 1140px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }

  /* Hero Card */
  .hero-card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 40px 36px;
    box-shadow: var(--shadow);
    margin-bottom: 28px;
    position: relative;
    overflow: hidden;
  }
  .hero-card::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: var(--doc-accent);
  }
  .hero-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    margin-bottom: 24px;
  }
  .hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--doc-accent);
    margin-bottom: 8px;
  }
  .hero-eyebrow::before {
    content: "";
    width: 18px;
    height: 2px;
    background: var(--doc-accent);
  }
  .hero-title {
    font-family: 'Poppins', sans-serif;
    font-size: clamp(24px, 3.2vw, 36px);
    font-weight: 700;
    color: var(--deep);
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin-bottom: 12px;
  }
  .hero-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .client-badge-box {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 20px;
    text-align: center;
    min-width: 180px;
    flex-shrink: 0;
  }
  .client-badge-label {
    font-size: 10.5px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
  }
  .client-badge-name {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    font-weight: 600;
    color: var(--deep);
  }

  /* Method KPI Grid */
  .method-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    margin-top: 24px;
  }
  .method-cell {
    background: var(--card);
    padding: 16px 20px;
  }
  .method-cell-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .method-cell-val {
    font-family: 'Poppins', sans-serif;
    font-size: 14.5px;
    font-weight: 600;
    color: var(--deep);
  }

  /* Proposal Section */
  .proposal-section {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 36px 36px;
    box-shadow: var(--shadow);
    margin-bottom: 28px;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .section-header > div {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .section-number {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
    background: var(--deep);
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .section-title {
    font-family: 'Poppins', sans-serif;
    font-size: 20px;
    font-weight: 600;
    color: var(--deep);
    letter-spacing: -0.01em;
  }
  .section-badge {
    font-size: 11.5px;
    font-weight: 600;
    background: var(--paper);
    color: var(--muted);
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--line);
  }
  .section-narrative {
    font-size: 14.5px;
    color: var(--ink);
    margin-bottom: 24px;
    line-height: 1.65;
    white-space: pre-line;
  }

  /* Deliverable Card Grid */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 18px;
    margin-top: 16px;
  }
  .deliverable-card {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px 22px;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .deliverable-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(12, 44, 62, 0.06);
    border-color: #cbd5e1;
  }
  .card-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
  }
  .card-number {
    font-size: 11px;
    font-weight: 700;
    color: var(--doc-accent);
    background: var(--flame-soft);
    padding: 2px 7px;
    border-radius: 5px;
    flex-shrink: 0;
  }
  .card-title {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    font-weight: 600;
    color: var(--deep);
    line-height: 1.3;
  }
  .card-desc {
    font-size: 13.5px;
    color: var(--muted);
    line-height: 1.55;
    white-space: pre-line;
  }

  /* Styled List */
  .styled-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }
  .styled-list li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 14px;
    color: var(--ink);
    line-height: 1.55;
  }
  .list-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--doc-accent);
    margin-top: 8px;
    flex-shrink: 0;
  }

  /* Badge Wrap */
  .badge-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .app-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
    background: #ffffff;
    border: 1px solid var(--line);
    padding: 6px 12px;
    border-radius: 8px;
    color: var(--deep);
  }
  .badge-icon {
    width: 14px;
    height: 14px;
    color: var(--success);
  }

  /* Terms Callout */
  .terms-box {
    background: var(--paper);
    border: 1px solid var(--line);
    border-left: 3px solid var(--doc-accent);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .terms-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .terms-value {
    font-size: 14px;
    color: var(--deep);
    font-weight: 500;
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
    .container { padding: 20px 16px 48px; }
    .hero-card, .proposal-section { padding: 24px 20px; }
    .hero-top { flex-direction: column; }
    .client-badge-box { width: 100%; }
    .signoff-box { grid-template-columns: 1fr; gap: 20px; }
  }

  @media print {
    .top-brand-bar, .sub-nav, .print-btn { display: none !important; }
    body { background: #ffffff !important; }
    .container { max-width: 100% !important; padding: 0 !important; }
    .hero-card, .proposal-section { border: 1px solid #ddd !important; box-shadow: none !important; page-break-inside: avoid; }
  }
</style>
</head>
<body>

<!-- Top Brand Bar with 3-Document Switcher -->
<header class="top-brand-bar">
  <div class="brand-bar-inner">
    <div class="brand-logo-wrap">
      <div class="spikra-brand-badge">SPIKRA<span>.</span></div>
      <span class="partner-tag">Zoho Advanced Partner</span>
    </div>

    ${buildDocumentSwitcherHtml(docType, proposalId, options)}

    <div class="header-actions">
      <button class="print-btn" onclick="window.print()">Export / Print</button>
    </div>
  </div>
</header>

<!-- Sticky Sub-Navigation -->
<nav class="sub-nav">
  <div class="sub-nav-inner">
    ${navLinksHtml}
  </div>
</nav>

<div class="container">

  <!-- Hero Card -->
  <section class="hero-card" id="hero">
    <div class="hero-top">
      <div>
        <div class="hero-eyebrow">${safeEyebrow}</div>
        <h1 class="hero-title">${safeDocTitle}</h1>
        <div class="hero-meta">
          <span>Prepared for <strong>${escapeHtml(customerName)}</strong></span>
          ${industryText ? `<span>· Industry: <strong>${escapeHtml(industryText)}</strong></span>` : ""}
          <span>· Date: <strong>${dateStr}</strong></span>
        </div>
      </div>
      <div class="client-badge-box">
        <div class="client-badge-label">Client Organization</div>
        <div class="client-badge-name">${escapeHtml(customerName)}</div>
      </div>
    </div>

    <!-- Method KPI Cell -->
    <div class="method-grid">
      <div class="method-cell">
        <div class="method-cell-label">Document Purpose</div>
        <div class="method-cell-val">${safeBadge}</div>
      </div>
      <div class="method-cell">
        <div class="method-cell-label">Architecture</div>
        <div class="method-cell-val">Zoho Enterprise Ecosystem</div>
      </div>
      <div class="method-cell">
        <div class="method-cell-label">Delivery Partner</div>
        <div class="method-cell-val">Spikra Solutions</div>
      </div>
      <div class="method-cell">
        <div class="method-cell-label">Engagement Status</div>
        <div class="method-cell-val" style="color: var(--doc-accent);">Executive Baseline</div>
      </div>
    </div>
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
    <p>Spikra Solutions · Zoho Advanced Partner · Confidential &amp; Proprietary</p>
    <p style="margin-top: 4px; font-size: 11px;">Prepared exclusively for ${escapeHtml(customerName)}.</p>
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
