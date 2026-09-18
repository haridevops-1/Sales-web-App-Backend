# Spikra Customer Experience Engine — Backend

This repository contains the backend microservices and frontend for the **Spikra AI Proposal Web App**, built on **Zoho Catalyst (Node.js 22)**. It lets an internal sales rep upload a technical/BRD document after a discovery call and get back a shareable, Spikra-branded proposal link for the client — instead of sending a 20+ page document nobody reads in full.

---

## 1. Business Flow

1. Sales rep uploads a technical document (PDF, ≤25MB) + business name + optional logo through the Slate web app.
2. The document is stored in Stratus and its text extracted.
3. **Deployed Zia Agent (Zoho Zia Agents)** analyzes the complete extracted text and returns structured Customer Showcase data (modules, deliverables, benefits, capabilities, timeline, governance) via Function 3.
4. **Function 4 (Pure Renderer)** hydrates that structured data into the fixed Spikra HTML/CSS/JS master template (`templates/iSteel_Proposal_Site.html` / `template.html`) with zero AI calls.
5. The generated page is published as a link the rep can copy and send to the client.

## 2. Directory Structure Overview

```
spikra-catalyst/
├── functions/                    # Zoho Catalyst Serverless Functions (Microservices)
│   ├── spikra_document_upload/     # Function 1: File upload & initial job creation (Advanced I/O)
│   ├── spikra_document_process/    # Function 2: PDF text extraction & validation (Basic I/O)
│   ├── spikra_ai_analysis/         # Function 3: Zia Agent orchestration bridge & structured Showcase extraction (Advanced I/O)
│   ├── spikra_experience_generate/ # Function 4: Pure HTML/CSS/JSON master template renderer (Basic I/O, zero AI calls)
│   ├── spikra_experience_deploy/   # Function 5: Publishes the experience & returns the customer link (Advanced I/O)
│   ├── spikra_process_status/      # Function 6: Real-time stage monitoring & status polling (Advanced I/O)
│   └── spikra_experience_list/     # Function 7: Paginated experience listing & search (Advanced I/O)
│
├── shared/                       # Shared Backend Libraries & Abstractions (source of truth; copied into each function)
│   ├── agent/                      # Zia Agent client layer
│   │   └── index.js                  # Zia Agent client, HTTP dispatcher & Showcase schema normalization
│   ├── datastore/                  # Targeted single-row Data Store access helpers
│   │   └── targetedQueries.js        # Single-row query helpers (`getRow`, targeted ZCQL with LIMIT 1)
│   └── utils/                      # Streaming, sanitization, and escaping utilities
│       └── index.js                  # `streamToBuffer`, `escapeHtml`, error sanitization
│
├── slate/                        # Catalyst Slate Web Application (Frontend) — deployed ONCE
│   └── spikra-experience/          # Self-contained default Spikra proposal template
│       ├── .catalyst/                # Slate configuration (slate-config.toml)
│       └── index.html                # iSteel sample proposal template and inline interactions
│
├── templates/                    # Master Customer Proposal HTML Templates (Design Source of Truth)
│   └── iSteel_Proposal_Site.html   # Spikra master proposal template
│
├── scripts/                      # Build Utilities
│   └── build_slate_index.js        # Compiles Slate proposal shell from master HTML template
│
├── catalyst.json                 # Catalyst project target definitions (Functions, Slate, APIG)
├── catalyst-user-rules.json      # Catalyst API Gateway route mappings & throttling rules
├── .catalystrc                   # Active project ID & datacenter config
├── .catalystignore               # Deployment exclusions
├── package.json                  # Root Node.js dependencies & test scripts
└── README.md                     # This documentation
```

---

## 3. Component Descriptions

### A. Functions (`functions/`)
Each function runs as an isolated Node.js 22 service with its own `catalyst-config.json` and dependencies:
- **`spikra_document_upload`** (Function 1): Validates file types (PDF, Text ≤25MB), sanitizes business/project names, writes raw files to Stratus bucket `spikra-process-documents-698386704`, and queues the `EXTRACT` job in `PROCESSING_JOBS`.
- **`spikra_document_process`** (Function 2): Extracts plain text from the uploaded document, checks word count, saves `extracted-content.txt` to Stratus, and advances state to `ANALYZE`.
- **`spikra_ai_analysis`** (Function 3): Orchestrates AI document analysis via the **deployed Zia Agent API**. Passes extracted document content and business metadata, validates the response, extracts structured Customer Showcase JSON, writes `analysis.json` to `spikra-generated-experiences-698386704`, and queues `GENERATE`.
- **`spikra_experience_generate`** (Function 4): Consumes Function 3's structured JSON (**zero AI calls**), renders the master HTML/CSS/JS bundles adhering strictly to the Spikra fixed design system (`templates/iSteel_Proposal_Site.html` / `template.html`), and stores them in `spikra-generated-experiences-698386704/projects/{id}/experiences/{id}/version-1/`.
- **`spikra_experience_deploy`** (Function 5): Verifies the generated files exist in Stratus and marks `EXPERIENCES.status = PUBLISHED` with a link into the single shared Slate app, scoped by `experience_id`/`project_id` query params.
- **`spikra_process_status`** (Function 6): Real-time polling endpoint returning clean salesperson status (`current_stage`, `business_name`, `project_name`, `generated_url` upon publish) without leaking storage internals.
- **`spikra_experience_list`** (Function 7): Lists and filters generated experiences across projects with pagination.

### B. AI Architecture & Core Design Principle
- **Deployed Zia Agent (Zoho Zia Agents)** is the sole AI orchestration layer. Claude is configured as the LLM provider **inside the Zia Agent** (Zoho Zia Agent Studio → Agent → Model settings) — it is never configured or called from this Catalyst backend.
- **Zero Direct External AI API Usage**: Function 3 and Function 4 make no direct calls to external AI APIs (Claude, Anthropic, OpenAI, or any other LLM). Orchestration is managed entirely within the deployed Zia Agent.
- **Strict Separation of Concerns**:
  - **Function 3**: Catalyst → Zia Agent bridge. Packages document text, calls the Agent endpoint, validates and extracts structured Showcase JSON.
  - **Function 4**: Zia Agent Output → Master Template renderer. Pure template hydration in code with zero AI calls.
  - **Spikra controls DESIGN**: Header, footer, theme, colors, typography, layout, navigation, tabs, cards — fixed in code, never by the model.
- **Anti-hallucination guard**: The Zia Agent client (`shared/agent/index.js`, `ZiaAgentClient.hasMeaningfulShowcaseContent`) validates that the Agent's response actually contains a recognizable Showcase structure (a title/summary plus at least two of `deliverable_cards`/`capabilities`/`customer_benefits`/`timeline_phases`) **before** accepting it. An empty, malformed, or off-schema Agent response throws a `SchemaValidationError` and Function 3 reports a `FAILED` job state — it never silently substitutes fully generic, fabricated customer content in place of a real Agent failure. (Field-level defaults inside `normalizeShowcaseContent`/Function 4's renderer only fill minor gaps in an already-valid response — e.g. padding 5 deliverable cards up to the required 6 — they do not run when the Agent response is empty or unrecognizable.)

### C. Deployment Model — one Slate app, not one per business
The Slate app at `slate/spikra-experience/` is deployed **once** via the Catalyst CLI (`catalyst deploy --only slate`). Its default route is the self-contained iSteel sample proposal template. Function 5 verifies generated files exist in Stratus and returns the link scoped by `experience_id` and `project_id`.

### D. Environment Configuration
For local scripts, copy `.env.example` to `.env` and fill in only local values. The `.env` file is ignored by Git and must never be committed. For deployed functions, the same variables are declared in `functions/spikra_ai_analysis/catalyst-config.json` (`deployment.env_variables`) and should be set to their real values in the Catalyst Console for each environment:
- `ZIA_AGENT_ENDPOINT`: Deployed Zia Agent endpoint URL. **Paste the real deployed Zia Agent URL here** — in both `.env` (local) and `functions/spikra_ai_analysis/catalyst-config.json` (deployed). Defaults to the placeholder `[PASTE ZIA AGENT URL HERE]`, which is treated as "not configured" by `ZiaAgentClient.isConfigured()`.
- `ZIA_AGENT_AUTH_TOKEN`: Optional authentication token (if required by the endpoint).
- `ZIA_AGENT_API_KEY`: Optional API key alias supported by the Zia Agent client (used only if `ZIA_AGENT_AUTH_TOKEN` is not set).
- `ZIA_AGENT_ID`: Optional. Only needed if your deployed Agent's invocation contract requires an explicit agent id in the request body in addition to the endpoint URL. Leave blank if the endpoint alone is sufficient.
- `SLATE_APP_URL`: Slate app base domain (default: `https://spikra-ai-proposal.onslate.com`)

**Claude / LLM configuration is out of scope for this repository.** Claude is configured directly inside the deployed Zia Agent (Zoho Zia Agent Studio → Agent → Model settings) — `CLAUDE_MODEL` / `CLAUDE_API_KEY` are documented as reference-only placeholders in `.env.example` and must never be wired into any Catalyst function, `.env` value read by function code, or `catalyst-config.json`. Function 3 and Function 4 must never call Claude/Anthropic directly.

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
catalyst deploy --only functions:spikra_ai_analysis
```
