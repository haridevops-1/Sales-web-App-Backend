"use strict";

/**
 * Spikra Customer Solution Proposal Renderer
 * Hydrates validated structured content from the Customer Proposal Generation Agent
 * into the Spikra Master Proposal Design System (Inter & Poppins typography, Spikra color tokens,
 * executive hero banner, Zoho partner badge, sticky section navigation, structured deliverable cards,
 * phased implementation roadmap, and governance/commercials).
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

function renderDeliverables(deliverables, requirements, emptyText) {
	let cards = [];
	if (Array.isArray(deliverables) && deliverables.length > 0) {
		cards = deliverables;
	} else if (Array.isArray(requirements) && requirements.length > 0) {
		cards = requirements.map((req, idx) => ({
			title: `Module ${idx + 1}`,
			description: req
		}));
	}

	if (cards.length === 0) {
		return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
	}

	return `<div class="card-grid">${cards.map((card, i) => {
		const title = typeof card === "object" && card.title ? card.title : `Scope Item ${i + 1}`;
		const desc = typeof card === "object" && card.description ? card.description : (typeof card === "string" ? card : JSON.stringify(card));
		const scope = typeof card === "object" && card.scope ? card.scope : null;
		return `
		<div class="deliverable-card">
			<div class="card-header">
				<div class="card-number">0${(i + 1).toString().slice(-2)}</div>
				<h3 class="card-title">${escapeHtml(title)}</h3>
			</div>
			<p class="card-desc">${escapeHtml(desc)}</p>
			${scope ? `<div class="card-scope"><strong>Scope:</strong> ${escapeHtml(scope)}</div>` : ""}
		</div>`;
	}).join("")}</div>`;
}

function renderMilestones(milestones, emptyText) {
	const list = (Array.isArray(milestones) ? milestones : []).filter(Boolean);
	if (list.length === 0) {
		return `
		<div class="roadmap-timeline">
			<div class="timeline-step">
				<div class="step-num">Phase 1</div>
				<div class="step-content">
					<h4>Discovery &amp; Architecture</h4>
					<p>Requirement gathering, scope baseline, integration architecture, and process blueprints.</p>
				</div>
			</div>
			<div class="timeline-step">
				<div class="step-num">Phase 2</div>
				<div class="step-content">
					<h4>Platform Configuration &amp; Development</h4>
					<p>Zoho module setup, custom workflows, data model alignment, and API integrations.</p>
				</div>
			</div>
			<div class="timeline-step">
				<div class="step-num">Phase 3</div>
				<div class="step-content">
					<h4>User Acceptance &amp; Production Rollout</h4>
					<p>End-to-end UAT testing, user enablement training, production deployment, and go-live.</p>
				</div>
			</div>
		</div>`;
	}

	return `<div class="roadmap-timeline">${list.map((m, i) => {
		const phase = typeof m === "object" ? (m.phase_name || m.title || `Phase ${i + 1}`) : `Phase ${i + 1}`;
		const desc = typeof m === "object" ? (m.description || m.milestones || JSON.stringify(m)) : String(m);
		const timeline = typeof m === "object" && m.timeline ? m.timeline : "";
		return `
		<div class="timeline-step">
			<div class="step-num">${escapeHtml(phase)}</div>
			<div class="step-content">
				${timeline ? `<div class="step-timeline">${escapeHtml(timeline)}</div>` : ""}
				<p>${escapeHtml(desc)}</p>
			</div>
		</div>`;
	}).join("")}</div>`;
}

function renderProposalDocument(ziaResponse, { customerName, industry, generatedAt } = {}) {
	const customer = (ziaResponse && ziaResponse.customer) || {};
	const companyName = String(customerName || customer.company_name || "Client Organization").trim();
	const industryText = String(industry || customer.industry || "").trim();
	const businessContext = String(customer.business_context || "").trim();

	const goals = Array.isArray(ziaResponse.goals) ? ziaResponse.goals : [];
	const requirements = Array.isArray(ziaResponse.requirements) ? ziaResponse.requirements : [];
	const painPoints = Array.isArray(ziaResponse.pain_points) ? ziaResponse.pain_points : [];
	const existingProcess = Array.isArray(ziaResponse.existing_process) ? ziaResponse.existing_process : [];
	const proposedSolution = Array.isArray(ziaResponse.proposed_solution) ? ziaResponse.proposed_solution : [];
	const zohoSolutions = Array.isArray(ziaResponse.zoho_solutions) ? ziaResponse.zoho_solutions : [];
	const expectedOutcomes = Array.isArray(ziaResponse.expected_outcomes) ? ziaResponse.expected_outcomes : [];
	const deliverables = Array.isArray(ziaResponse.deliverables) ? ziaResponse.deliverables : [];
	const milestones = Array.isArray(ziaResponse.implementation_milestones) ? ziaResponse.implementation_milestones : [];
	const assumptions = Array.isArray(ziaResponse.assumptions) ? ziaResponse.assumptions : [];

	const licenseCostInfo = ziaResponse.license_cost_info || null;
	const paymentTerms = ziaResponse.payment_terms || null;
	const supportHypercare = ziaResponse.support_hypercare || null;

	const generatedDate = generatedAt ? new Date(generatedAt) : new Date();
	const dateStr = isNaN(generatedDate.getTime())
		? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
		: generatedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const safeTitle = escapeHtml(`${companyName} — Solution Proposal | Spikra`);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<meta name="description" content="Commercial &amp; Technical Solution Proposal prepared for ${escapeHtml(companyName)} by Spikra">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #14415A;
    --deep: #0C2C3E;
    --flame: #F4611F;
    --flame-soft: #FFF3EC;
    --paper: #F7F9FA;
    --card: #FFFFFF;
    --line: #E3E9ED;
    --muted: #6B7C87;
    --success: #10B981;
    --success-soft: #ECFDF5;
    --radius: 12px;
    --shadow: 0 1px 3px rgba(12, 44, 62, 0.05), 0 8px 24px rgba(12, 44, 62, 0.06);
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
  h1, h2, h3, h4 { font-family: 'Poppins', sans-serif; color: var(--deep); }
  
  /* Top Brand Header */
  .top-brand-bar {
    background: #ffffff;
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 1000;
    box-shadow: 0 1px 4px rgba(0,0,0,0.03);
  }
  .brand-bar-inner {
    max-width: 1080px;
    margin: 0 auto;
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand-logo-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .spikra-brand-badge {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--deep);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spikra-brand-badge span {
    color: var(--flame);
  }
  .partner-tag {
    background: #f0fdf4;
    color: #15803d;
    border: 1px solid #bbf7d0;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .print-btn {
    background: #ffffff;
    border: 1px solid var(--line);
    color: var(--ink);
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .print-btn:hover {
    background: var(--flame-soft);
    border-color: var(--flame);
    color: var(--flame);
  }

  /* Sticky Sub-Nav */
  .sub-nav {
    background: #ffffff;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }
  .sub-nav-inner {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    gap: 24px;
  }
  .sub-nav a {
    text-decoration: none;
    color: var(--muted);
    font-size: 13px;
    font-weight: 500;
    padding: 12px 0;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .sub-nav a:hover {
    color: var(--flame);
    border-bottom-color: var(--flame);
  }

  /* Main Container */
  .container {
    max-width: 1080px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }

  /* Hero Section */
  .hero-card {
    background: #ffffff;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 40px;
    box-shadow: var(--shadow);
    margin-bottom: 40px;
    position: relative;
    overflow: hidden;
  }
  .hero-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, #F4611F 0%, #2C7CB8 100%);
  }
  .hero-eyebrow {
    display: inline-block;
    color: var(--flame);
    background: var(--flame-soft);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 16px;
  }
  .hero-title {
    font-size: 32px;
    line-height: 1.25;
    margin-bottom: 12px;
  }
  .hero-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    color: var(--muted);
    font-size: 14px;
  }
  .meta-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Proposal Sections */
  .proposal-section {
    background: #ffffff;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 36px;
    box-shadow: var(--shadow);
    margin-bottom: 32px;
  }
  .section-header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .section-title {
    font-size: 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section-badge {
    background: var(--paper);
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 4px;
  }

  /* Subsection Grids */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  @media (max-width: 768px) {
    .grid-2 { grid-template-columns: 1fr; }
    .hero-card, .proposal-section { padding: 24px; }
  }

  .box-card {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 20px;
  }
  .box-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 12px;
    color: var(--deep);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Lists */
  .styled-list {
    list-style: none;
  }
  .styled-list li {
    position: relative;
    padding-left: 20px;
    margin-bottom: 10px;
    font-size: 14px;
    color: #2c3e50;
    line-height: 1.5;
  }
  .styled-list li .list-dot {
    position: absolute;
    left: 0;
    top: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--flame);
  }
  .empty-note {
    font-style: italic;
    color: var(--muted);
    font-size: 14px;
  }

  /* Zoho Apps Badges */
  .badge-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .app-badge {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    color: var(--deep);
    font-size: 13px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 20px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  }
  .badge-icon {
    width: 14px;
    height: 14px;
    color: var(--flame);
  }

  /* Deliverable Cards */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
  }
  .deliverable-card {
    background: #ffffff;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .deliverable-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    border-color: #cbd5e1;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .card-number {
    background: var(--flame-soft);
    color: var(--flame);
    font-size: 12px;
    font-weight: 700;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-title {
    font-size: 15px;
    font-weight: 600;
  }
  .card-desc {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.55;
    margin-bottom: 8px;
  }
  .card-scope {
    font-size: 12px;
    color: #475569;
    background: var(--paper);
    padding: 6px 10px;
    border-radius: 6px;
    border-left: 2px solid var(--flame);
  }

  /* Roadmap Timeline */
  .roadmap-timeline {
    position: relative;
    border-left: 2px solid var(--line);
    margin-left: 16px;
    padding-left: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .timeline-step {
    position: relative;
  }
  .timeline-step::before {
    content: '';
    position: absolute;
    left: -31px;
    top: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ffffff;
    border: 3px solid var(--flame);
  }
  .step-num {
    font-size: 12px;
    font-weight: 700;
    color: var(--flame);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  .step-content h4 {
    font-size: 15px;
    margin-bottom: 4px;
  }
  .step-content p {
    font-size: 13px;
    color: var(--muted);
  }
  .step-timeline {
    font-size: 12px;
    font-weight: 600;
    color: var(--deep);
    background: var(--flame-soft);
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    margin-bottom: 6px;
  }

  /* Commercials & Terms Callout */
  .terms-box {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .terms-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--deep);
    margin-bottom: 6px;
  }
  .terms-value {
    font-size: 13px;
    color: #475569;
  }

  /* Sign-Off Block */
  .signoff-box {
    background: #f8fafc;
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    padding: 24px;
    margin-top: 24px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
  }
  .sign-col h5 {
    font-size: 13px;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 24px;
  }
  .sign-line {
    border-top: 1px solid #cbd5e1;
    padding-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  /* Footer */
  .proposal-footer {
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }

  @media print {
    .top-brand-bar, .sub-nav, .print-btn { display: none !important; }
    body { background: #ffffff !important; }
    .hero-card, .proposal-section { box-shadow: none !important; border: 1px solid #cbd5e1 !important; page-break-inside: avoid; }
    .container { padding: 0 !important; }
  }
</style>
</head>
<body>

<!-- Top Brand Bar -->
<header class="top-brand-bar">
  <div class="brand-bar-inner">
    <div class="brand-logo-wrap">
      <div class="spikra-brand-badge">SPIKRA<span>.</span></div>
      <span class="partner-tag">Zoho Advanced Partner</span>
    </div>
    <div class="header-actions">
      <button class="print-btn" onclick="window.print()">Export / Print</button>
    </div>
  </div>
</header>

<!-- Sticky Sub-Navigation -->
<nav class="sub-nav">
  <div class="sub-nav-inner">
    <a href="#overview">Overview &amp; Context</a>
    <a href="#architecture">Architecture &amp; Solutions</a>
    <a href="#deliverables">Scope &amp; Deliverables</a>
    <a href="#roadmap">Roadmap &amp; Milestones</a>
    <a href="#governance">Governance &amp; Terms</a>
  </div>
</nav>

<div class="container">

  <!-- Hero Card -->
  <section class="hero-card" id="hero">
    <div class="hero-eyebrow">Executive Solution Proposal</div>
    <h1 class="hero-title">${escapeHtml(companyName)}</h1>
    <div class="hero-meta">
      ${industryText ? `<div class="meta-item"><svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a1 1 0 110 2h-3a1 1 0 01-1-1v-2a1 1 0 00-1-1H9a1 1 0 00-1 1v2a1 1 0 01-1 1H4a1 1 0 110-2V4zm3 1h2v2H7V5zm2 4H7v2h2V9zm2-4h2v2h-2V5zm2 4h-2v2h2V9z" clip-rule="evenodd"/></svg>${escapeHtml(industryText)}</div>` : ""}
      <div class="meta-item">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
        ${escapeHtml(dateStr)}
      </div>
      <div class="meta-item">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
        Confidential &amp; Tailored
      </div>
    </div>
  </section>

  <!-- Section 1: Overview & Discovery Context -->
  <section class="proposal-section" id="overview">
    <div class="section-header">
      <h2 class="section-title">1. Executive Summary &amp; Discovery Context</h2>
      <span class="section-badge">Discovery Insights</span>
    </div>
    
    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 16px; margin-bottom: 8px;">Business Context</h3>
      ${businessContext ? `<p style="color: #334155; font-size: 14px; line-height: 1.6;">${escapeHtml(businessContext)}</p>` : `<p class="empty-note">Not specified in the discovery documents.</p>`}
    </div>

    <div class="grid-2">
      <div class="box-card">
        <h4 class="box-title">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="#10b981"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
          Strategic Customer Goals
        </h4>
        ${renderListItems(goals, "No specific strategic goals recorded in discovery documents.")}
      </div>

      <div class="box-card">
        <h4 class="box-title">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="#ef4444"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
          Challenges &amp; Pain Points
        </h4>
        ${renderListItems(painPoints, "No specific pain points recorded in discovery documents.")}
      </div>
    </div>

    ${existingProcess.length > 0 ? `
    <div style="margin-top: 24px;">
      <div class="box-card">
        <h4 class="box-title">Current Process &amp; Legacy Ecosystem</h4>
        ${renderListItems(existingProcess, "Not specified.")}
      </div>
    </div>` : ""}
  </section>

  <!-- Section 2: Proposed Architecture & Zoho Solutions -->
  <section class="proposal-section" id="architecture">
    <div class="section-header">
      <h2 class="section-title">2. Solution Architecture &amp; Zoho Platform</h2>
      <span class="section-badge">Solution Blueprint</span>
    </div>

    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 16px; margin-bottom: 8px;">Proposed Solution Overview</h3>
      ${renderListItems(proposedSolution, "Solution specifications derived directly from customer discovery.")}
    </div>

    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 16px; margin-bottom: 12px;">Relevant Zoho Applications</h3>
      ${renderBadgeList(zohoSolutions, "Zoho CRM & platform applications tailored to customer requirements.")}
    </div>

    ${expectedOutcomes.length > 0 ? `
    <div>
      <h3 style="font-size: 16px; margin-bottom: 12px;">Expected Business Outcomes</h3>
      <div class="box-card" style="background: var(--success-soft); border-color: #a7f3d0;">
        ${renderListItems(expectedOutcomes, "Outcomes aligned with customer objectives.")}
      </div>
    </div>` : ""}
  </section>

  <!-- Section 3: Scope of Work & Deliverables -->
  <section class="proposal-section" id="deliverables">
    <div class="section-header">
      <h2 class="section-title">3. Scope of Work &amp; Deliverables</h2>
      <span class="section-badge">Deliverables Catalog</span>
    </div>

    ${renderDeliverables(deliverables, requirements, "Deliverables scoped strictly from customer requirements.")}
  </section>

  <!-- Section 4: Implementation Roadmap & Milestones -->
  <section class="proposal-section" id="roadmap">
    <div class="section-header">
      <h2 class="section-title">4. Implementation Roadmap</h2>
      <span class="section-badge">Execution Timeline</span>
    </div>

    ${renderMilestones(milestones, "Standard three-phase implementation roadmap.")}
  </section>

  <!-- Section 5: Governance, Commercials & Hypercare -->
  <section class="proposal-section" id="governance">
    <div class="section-header">
      <h2 class="section-title">5. Commercials, Governance &amp; Support</h2>
      <span class="section-badge">Terms &amp; Commitments</span>
    </div>

    <div class="grid-2">
      <div>
        <div class="terms-box">
          <div class="terms-title">Licensing &amp; Commercial Terms</div>
          <div class="terms-value">
            ${licenseCostInfo ? escapeHtml(typeof licenseCostInfo === "object" ? JSON.stringify(licenseCostInfo) : String(licenseCostInfo)) : "To be confirmed during commercial alignment."}
          </div>
        </div>

        <div class="terms-box">
          <div class="terms-title">Payment Milestones</div>
          <div class="terms-value">
            ${paymentTerms ? escapeHtml(typeof paymentTerms === "object" ? JSON.stringify(paymentTerms) : String(paymentTerms)) : "To be confirmed upon master service agreement execution."}
          </div>
        </div>

        <div class="terms-box">
          <div class="terms-title">Support &amp; Hypercare</div>
          <div class="terms-value">
            ${supportHypercare ? escapeHtml(typeof supportHypercare === "object" ? JSON.stringify(supportHypercare) : String(supportHypercare)) : "Includes dedicated 30-day Hypercare post go-live with warranty and transition handover."}
          </div>
        </div>
      </div>

      <div>
        <div class="box-card" style="height: 100%;">
          <h4 class="box-title">Key Assumptions &amp; Prerequisites</h4>
          ${renderListItems(assumptions.length > 0 ? assumptions : [
            "Customer will designate a Single Point of Contact (SPOC) for requirements sign-off.",
            "Timely access to legacy source systems and API credentials will be provided.",
            "User Acceptance Testing (UAT) will be executed per agreed milestone schedules.",
            "Scope changes will be managed via formal change request procedures."
          ], "Standard implementation assumptions apply.")}
        </div>
      </div>
    </div>

    <!-- Sign-off Block -->
    <div class="signoff-box">
      <div class="sign-col">
        <h5>Prepared by Spikra</h5>
        <div class="sign-line">Authorized Signatory · Spikra Solutions</div>
      </div>
      <div class="sign-col">
        <h5>Accepted by Customer</h5>
        <div class="sign-line">Authorized Signatory · ${escapeHtml(companyName)}</div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="proposal-footer">
    <p>Spikra Solutions · Zoho Advanced Partner · Confidential &amp; Proprietary</p>
    <p style="margin-top: 4px; font-size: 11px;">Prepared exclusively for ${escapeHtml(companyName)}.</p>
  </footer>

</div>

</body>
</html>`;
}

module.exports = { renderProposalDocument };
