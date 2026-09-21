"use strict";

// Renders a validated Zia response (see utils/validation) into one self-contained,
// static HTML "solution document" - the Workspace 2 equivalent of Workspace 1's
// Function 4 (spikra_experience_generate). Deliberately simpler than that template:
// Workspace 2's content is a set of plain text sections (goals, requirements, pain
// points, etc.), not iSteel's interactive tabbed/accordion showcase, so one inline-CSS
// page with no external JS is the right amount of complexity here - not a smaller copy
// of a design that doesn't fit this content shape.

function escapeHtml(str) {
	return String(str == null ? "" : str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderList(items, emptyText) {
	const clean = (Array.isArray(items) ? items : []).map((s) => String(s || "").trim()).filter(Boolean);
	if (clean.length === 0) {
		return `<p class="empty">${escapeHtml(emptyText)}</p>`;
	}
	return `<ul>${clean.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

// ziaResponse must already be validateZiaResponse-clean (proposal-agent validates before
// calling this) - this function trusts its shape and only escapes values, never invents them.
function renderProposalDocument(ziaResponse, { customerName, industry, generatedAt } = {}) {
	const customer = ziaResponse.customer || {};
	const companyName = String(customerName || customer.company_name || "Prospective Customer").trim();
	const industryText = String(industry || customer.industry || "").trim();
	const businessContext = String(customer.business_context || "").trim();
	const generatedDate = generatedAt ? new Date(generatedAt) : new Date();
	const generatedDateText = isNaN(generatedDate.getTime())
		? ""
		: generatedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

	const safeTitle = escapeHtml(`${companyName} — Solution Proposal`);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<meta name="description" content="Solution proposal prepared for ${escapeHtml(companyName)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --ink:#0f2b3c; --muted:#5b6b76; --line:#e4e9ec; --flame:#ff5a1f; --flame-soft:#fff1ea; --bg:#f8fafc; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:'Inter',sans-serif; line-height:1.6; }
  h1,h2 { font-family:'Poppins',sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:48px 24px 80px; }
  header { border-bottom:2px solid var(--flame); padding-bottom:24px; margin-bottom:32px; }
  .eyebrow { color:var(--flame); font-weight:600; font-size:13px; letter-spacing:.06em; text-transform:uppercase; }
  h1 { font-size:28px; margin:8px 0 4px; }
  .meta { color:var(--muted); font-size:14px; }
  section { margin-bottom:32px; }
  h2 { font-size:18px; color:var(--ink); margin:0 0 12px; padding:8px 14px; background:var(--flame-soft); border-radius:8px; display:inline-block; }
  p { margin:0 0 12px; }
  p.empty { color:var(--muted); font-style:italic; }
  ul { margin:0; padding-left:20px; }
  li { margin-bottom:8px; }
  footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Solution Proposal</div>
    <h1>${escapeHtml(companyName)}</h1>
    <div class="meta">${industryText ? `${escapeHtml(industryText)} · ` : ""}${escapeHtml(generatedDateText)}</div>
  </header>

  <section>
    <h2>About the Customer</h2>
    ${businessContext ? `<p>${escapeHtml(businessContext)}</p>` : `<p class="empty">Not specified in the discovery package.</p>`}
  </section>

  <section>
    <h2>Customer Goals</h2>
    ${renderList(ziaResponse.goals, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Customer Requirements</h2>
    ${renderList(ziaResponse.requirements, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Business Challenges / Pain Points</h2>
    ${renderList(ziaResponse.pain_points, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Current Process</h2>
    ${renderList(ziaResponse.existing_process, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Proposed Solution</h2>
    ${renderList(ziaResponse.proposed_solution, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Relevant Zoho Applications</h2>
    ${renderList(ziaResponse.zoho_solutions, "Not specified in the discovery package.")}
  </section>

  <section>
    <h2>Expected Outcomes</h2>
    ${renderList(ziaResponse.expected_outcomes, "Not specified in the discovery package.")}
  </section>

  <footer>Prepared by Spikra · Confidential — for internal and customer discussion purposes.</footer>
</div>
</body>
</html>`;
}

module.exports = { renderProposalDocument };
