# Spikra Internal Sales Hub — Backend

This repository contains the backend for the **Spikra Internal Sales Hub**, built on **Zoho Catalyst (Node.js 22)**. It hosts two independent pipelines, both serverless, both API-gateway-routed from the same Catalyst project:

- **Workspace 1 — Customer Showcases**: upload a technical/BRD document, get back an interactive, Spikra-branded customer showcase link.
- **Workspace 2 — Solution Proposals**: pull discovery files from a salesperson's own Zoho WorkDrive, get back a structured solution proposal document.

Both pipelines share the same core shape (upload/gather → extract → analyze via a dedicated Zia Agent → render → publish → shareable link) but are otherwise fully separate: separate functions, separate Data Store tables, separate Stratus buckets, separate Zia Agents, separate Slate apps.

---

## 1. Workspace 1 — Business Flow

1. Sales rep uploads a technical document (PDF, ≤25MB) + business name + optional logo through the Slate web app.
2. The document is stored in Stratus and its text extracted.
3. **Deployed Zia Agent ("Customer Showcase Agent")** analyzes the complete extracted text and returns structured Customer Showcase data (deliverables, benefits, capabilities, timeline) via Function 3.
4. **Function 4 (Pure Renderer)** hydrates that structured data into the fixed Spikra HTML/CSS/JS master template (`templates/iSteel_Proposal_Site.html` / `template.html`) with zero AI calls.
5. The generated page is published as a link the rep can copy and send to the client.

## 2. Directory Structure Overview

```
spikra-catalyst/
├── functions/                    # Zoho Catalyst Serverless Functions (Microservices)
│   ├── spikra_document_upload/     # W1 Function 1: File upload & initial job creation (Advanced I/O)
│   ├── spikra_document_process/    # W1 Function 2: PDF text extraction & validation (Basic I/O)
│   ├── spikra_ai_analysis_v2/      # W1 Function 3: Zia Agent orchestration bridge & structured Showcase extraction (Advanced I/O)
│   ├── spikra_experience_generate/ # W1 Function 4: Pure HTML/CSS/JSON master template renderer (Basic I/O, zero AI calls)
│   ├── spikra_experience_deploy/   # W1 Function 5: Publishes the experience & returns the customer link (Advanced I/O)
│   ├── spikra_process_status/      # W1 Function 6: Real-time stage monitoring & status polling (Basic I/O)
│   ├── spikra_experience_list/     # W1 Function 7: Paginated experience listing & search (Basic I/O)
│   ├── proposal-workdrive-auth-v2/ # W2: Per-user Zoho WorkDrive OAuth (authorize/callback/status/disconnect)
│   ├── proposal-discovery/         # W2: Discovery package/file CRUD, private per salesperson
│   ├── proposal-processor/         # W2: Extracts discovery files, calls the Zia Agent, builds & renders the proposal
│   └── proposal-api/               # W2: Shared proposal list/detail/status-transition + public document view
│
├── shared/                       # Workspace 1 shared source of truth (copied into each W1 function)
│   ├── agent/                      # Zia Agent client layer
│   │   └── index.js                  # Zia Agent client, HTTP dispatcher & Showcase schema normalization
│   ├── datastore/                  # Targeted single-row Data Store access helpers
│   │   └── targetedQueries.js        # Single-row query helpers (`getRow`, targeted ZCQL with LIMIT 1)
│   └── utils/                      # Streaming, sanitization, and escaping utilities
│       └── index.js                  # `streamToBuffer`, `escapeHtml`, error sanitization
│
├── workspace2-proposal/          # Workspace 2 shared source of truth (copied into each W2 function)
│   ├── utils/                      # user-context (session auth), errors, logging, validation, cors
│   └── services/                   # auth, workdrive, document-processing, zia, proposal, document-render
│
├── slate/                        # Catalyst Slate Web Applications — each deployed ONCE
│   ├── spikra-experience/          # W1: self-contained default Spikra showcase template
│   │   ├── .catalyst/                # Slate configuration (slate-config.toml)
│   │   └── index.html                # iSteel sample showcase template and inline interactions
│   └── spikra-w2-proposal/         # W2: proposal viewer shell
│
├── templates/                    # Master Customer Showcase HTML Template (Design Source of Truth, W1 only)
│   └── iSteel_Proposal_Site.html   # Spikra master showcase template
│
├── scripts/                      # Build Utilities
│   └── build_slate_index.js        # Compiles Slate showcase shell from master HTML template
│
├── catalyst.json                 # Catalyst project target definitions (Functions, Slate apps, APIG)
├── catalyst-user-rules.json      # Catalyst API Gateway route mappings & throttling rules
├── .catalystrc                   # Active project ID & datacenter config
├── .catalystignore               # Deployment exclusions
├── package.json                  # Root Node.js dependencies & test scripts
└── README.md                     # This documentation
```

---

## 3. Component Descriptions

### A. Workspace 1 Functions (`functions/spikra_*`)
Each function runs as an isolated Node.js 22 service with its own `catalyst-config.json` and dependencies:
- **`spikra_document_upload`** (Function 1, Advanced I/O): Validates file types (PDF, Text ≤25MB), sanitizes business/project names, writes raw files to Stratus bucket `spikra-process-documents-698386704`, and queues the `EXTRACT` job in `PROCESSING_JOBS`.
- **`spikra_document_process`** (Function 2, Basic I/O): Extracts plain text from the uploaded document, checks word count, saves `extracted-content.txt` to Stratus, and advances state to `ANALYZE`.
- **`spikra_ai_analysis_v2`** (Function 3, Advanced I/O — recreated under a new name after the original was created as Basic I/O and Catalyst does not support converting an existing function's execution type in place): Orchestrates AI document analysis via the **deployed Zia Agent API**, authenticated through the Catalyst Connection `internalsaleshub`. Responds to the caller immediately (`still_processing: true`) and completes the actual Agent call in the background, so a slow model never causes a client-facing timeout — callers must poll the same endpoint until `success: true`. Validates the response, extracts structured Customer Showcase JSON, writes `analysis.json` to `spikra-generated-experiences-698386704`, and queues `GENERATE`.
- **`spikra_experience_generate`** (Function 4, Basic I/O): Consumes Function 3's structured JSON (**zero AI calls**), renders the master HTML/CSS/JS bundles adhering strictly to the Spikra fixed design system (`templates/iSteel_Proposal_Site.html` / `template.html`), and stores them in `spikra-generated-experiences-698386704/projects/{id}/experiences/{id}/version-1/`.
- **`spikra_experience_deploy`** (Function 5, Advanced I/O): Verifies the generated files exist in Stratus and marks `EXPERIENCES.status = PUBLISHED` with a link into the single shared Slate app, scoped by `experience_id`/`project_id` query params.
- **`spikra_process_status`** (Function 6, Basic I/O): Real-time polling endpoint returning clean salesperson status (`current_stage`, `business_name`, `project_name`, `generated_url` upon publish) without leaking storage internals.
- **`spikra_experience_list`** (Function 7, Basic I/O): Lists and filters generated experiences across projects with pagination.

### B. Workspace 2 Functions (`functions/proposal-*`)
- **`proposal-workdrive-auth-v2`** (Advanced I/O): Real per-user Zoho WorkDrive OAuth — `authorize`/`callback`/`status`/`disconnect`. No Catalyst login involved; a successful Zoho OAuth consent **is** the identity check. Issues a signed session token the frontend stores and sends back as `Authorization: Bearer <token>`.
- **`proposal-discovery`** (Advanced I/O): Create/list/get/delete a "discovery package" (one or more files, ≤25MB each, ≤120MB total) ahead of proposal generation. Private per salesperson email, resolved from the session token — never trusted from the request body.
- **`proposal-processor`** (Advanced I/O): Extracts text from a discovery package's files, calls the **deployed "Solution Proposal" Zia Agent** (same Connection-based auth pattern as Workspace 1), builds and stores the `W2_PROPOSALS` row, and renders + publishes the proposal document. Idempotent (returns the existing proposal if one was already generated for that package) with a 5-minute concurrency guard against duplicate Agent calls for the same package.
- **`proposal-api`** (Advanced I/O): Shared, org-wide proposal list/detail and status-transition (Draft → In Review → Approved, restricted to the creator), plus the public `resource=view` document route (no session required — this is the shareable link).

### C. AI Architecture & Core Design Principle
- Each workspace has its **own dedicated Zia Agent** — never shared, never cross-called. Both authenticate via a Catalyst Connection (`internalsaleshub`), never via manually stored OAuth tokens or API keys.
- **Zero Direct External AI API Usage**: no function in either workspace calls Claude, Anthropic, OpenAI, or any other LLM directly. Orchestration is managed entirely within each deployed Zia Agent.
- **Strict Separation of Concerns** (Workspace 1): Function 3 is the only Catalyst → Zia Agent bridge; Function 4 is Zia Agent output → Master Template renderer, pure hydration with zero AI calls. Spikra controls DESIGN — header, footer, theme, colors, typography, layout, navigation, tabs, cards are fixed in code, never chosen by the model.
- **No-fabrication guarantee**: Both workspaces validate that the Agent's response actually contains a recognizable structure before accepting it (Workspace 1: `ZiaAgentClient.hasMeaningfulShowcaseContent`; Workspace 2: `validateZiaResponse`) — an empty, malformed, or off-schema response is rejected outright, never silently replaced with generic content. Beyond that gate, normalization is **structural only**: it trims strings, caps array lengths, and drops malformed entries, but a field or array the Agent didn't populate stays `null`/empty rather than being padded with invented business content. Per-model token usage (`W2_AI_USAGE_LOG`) is only ever recorded when the Agent's response actually reports it — never estimated.

### D. Deployment Model — one Slate app per workspace, not one per business
Each Slate app (`slate/spikra-experience/`, `slate/spikra-w2-proposal/`) is deployed **once** via the Catalyst CLI (`catalyst deploy --only slate`). Every business/proposal gets a unique link via query params/slug on that same shared app, never a dedicated app per customer.

### E. Environment Configuration
For local scripts, copy `.env.example` to `.env` and fill in only local values. The `.env` file is ignored by Git and must never be committed. Deployed functions declare their own variables in their own `catalyst-config.json` (`deployment.env_variables`), set to real values in the Catalyst Console per environment:
- `ZIA_AGENT_ENDPOINT` (`functions/spikra_ai_analysis_v2/catalyst-config.json`): Deployed Workspace 1 Zia Agent trigger URL. Defaults to the placeholder `[PASTE ZIA AGENT URL HERE]`, treated as "not configured" by `ZiaAgentClient.isConfigured()`.
- `ZIA_AGENT_ID`: Optional — only needed if the Agent's invocation contract requires an explicit agent id in the request body in addition to the endpoint URL.
- `PROPOSAL_ZIA_AGENT_ENDPOINT` / `PROPOSAL_ZIA_CONNECTION_LINK_NAME` (`functions/proposal-processor/catalyst-config.json`): the Workspace 2 equivalent.
- `SLATE_APP_URL` / `PROPOSAL_SLATE_APP_URL`: each workspace's Slate app base domain.
- Authentication for both Zia Agents is via the Catalyst Connection `internalsaleshub` — there is no auth token or API key env var for either; do not add one.
- Workspace 2's WorkDrive OAuth needs its own real values: `WORKDRIVE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `WORKDRIVE_TOKEN_ENCRYPTION_KEY`, `WORKDRIVE_SESSION_SECRET` — see `workspace2-proposal/README.md` for the full setup.

**Claude / LLM configuration is out of scope for this repository.** Claude is configured directly inside each deployed Zia Agent (Zoho Zia Agent Studio → Agent → Model settings) — it must never be wired into any Catalyst function, `.env` value read by function code, or `catalyst-config.json`.

Never put passwords, API keys, access tokens, private keys, or other credentials in source files, JSON configuration, test fixtures, logs, or documentation. If a credential was ever committed, revoke and rotate it immediately; adding it to `.env` afterward does not remove it from Git history.

---

## 4. Development & Build Commands

### Build Slate App Shell
```bash
npm run build:slate
# or
node scripts/build_slate_index.js
```
Compiles and syncs the Slate proposal shell (`slate/spikra-experience/index.html` and `404.html`) from the master HTML template.

### Test Locally via Catalyst CLI
```bash
catalyst serve
```

### Deploy Backend Functions to Catalyst Console
```bash
catalyst deploy --only functions
```
Or deploy a specific function:
```bash
catalyst deploy --only functions:spikra_ai_analysis_v2
```
