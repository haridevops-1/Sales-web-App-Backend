# workspace2-proposal

Shared services and utilities for Workspace 2 (Solution Proposals). This is source code
only — it is never deployed as-is. Each Catalyst function under
`functions/proposal-*` copies what it needs from here into its own `shared/` subfolder
at build time and requires it with a local-first fallback:

```js
let workdrive;
try {
  workdrive = require("./shared/workdrive");
} catch {
  workdrive = require("../../workspace2-proposal/services/workdrive");
}
```

This mirrors exactly how Workspace 1's `shared/` folder is consumed by
`functions/spikra_*` — required because Catalyst deploys each function's directory in
isolation, with nothing outside it included.

## Layout

- `prompts/proposal-agent-instructions.md` — reference copy of the Workspace 2 Zia
  Agent's system prompt. The live prompt is configured in Zia Agent Studio; this file
  documents what it should say so the code's request/response handling stays in sync.
- `services/auth/` — real per-user OAuth 2.0 against Zoho's own WorkDrive endpoints
  (**not** the Catalyst Connections feature — confirmed that Connections return one
  shared credential set for every caller, which can't represent per-salesperson
  access). There is no separate app login: clicking "Open WorkDrive" goes straight to
  Zoho's own login/consent page, and that success IS the identity check — the same
  "Login with X" pattern any third-party-OAuth app uses. Builds the authorize URL
  (`state` is a plain CSRF nonce, carries no identity), exchanges the code, looks up the
  salesperson's email via `fetchZohoUserInfo`, issues/verifies the app's own signed
  session token (`issueSessionToken`/`verifySessionToken`, tied to that email, 30-day
  TTL, secret from `WORKDRIVE_SESSION_SECRET`), and encrypts/decrypts the OAuth tokens
  at rest (AES-256-GCM, separate key from `WORKDRIVE_TOKEN_ENCRYPTION_KEY`).
- `services/workdrive/` — WorkDrive API client backed by the `W2_USER_WORKDRIVE` table,
  keyed by the salesperson's Zoho email (not a Catalyst identity — there isn't one).
  Resolves a valid access token per email (via `services/auth`, refreshing
  transparently), never a Connection. Also handles disconnect (best-effort revoke at
  Zoho's end, then marks the row disconnected locally either way). Endpoint paths are
  marked `VERIFY` until confirmed against a real response.
- `services/zia/` — Workspace 2 Zia Agent client (same Connection-based auth pattern —
  this one *is* a shared, service-level Connection, which is correct here since the
  Agent itself isn't per-user — request/response contract, and anti-hallucination
  validation gate as Workspace 1's `shared/agent/index.js`).
- `services/document-processing/` — PDF/DOCX/XLSX extraction. PDF and DOCX reuse the
  exact proven engine chain from `functions/spikra_document_process`; XLSX is new
  (`xlsx` package). Raw audio/video is explicitly unsupported this milestone.
- `services/document-render/` — renders a validated Zia response into one
  self-contained static HTML "solution document" (inline CSS, no external JS - the
  content here is plain text sections, not an interactive showcase, so it doesn't need
  Workspace 1's multi-asset-file complexity). This is Workspace 2's equivalent of
  Workspace 1's Function 4 (`spikra_experience_generate`), scoped to a completely
  different content shape. `proposal-processor` uploads its output to a Workspace-2-only
  Stratus bucket (`spikra-w2-proposal-documents-698386704` - never Workspace 1's own
  bucket) and `proposal-api`'s `resource=view` route serves it back publicly, mirroring
  Workspace 1's Function 5 (`spikra_experience_deploy`) GET behavior. Workspace 2 also
  has its own Slate app (`slate/spikra-w2-proposal/`) that fetches from that view route
  and renders it in an iframe - the exact same "thin shell, real content served
  server-side" pattern as Workspace 1's own Slate app, just a much smaller copy since
  there's no slug routing or default sample template to carry over.
- `services/proposal/` also owns `buildProposalDocumentKey(userId, packageId,
  proposalId)` - the one place the Stratus object key for a proposal's document is
  computed (`proposals/<user_id>/<package_id>/<proposal_id>/index.html`), shared by
  the writer (`proposal-processor`) and the reader (`proposal-api`) so they can never
  drift apart. Scoped by user then package so the bucket's own folder structure says
  whose document is whose without needing to open the Data Store.
- `services/proposal/` — status-transition rules and Zia-response-to-`W2_PROPOSALS`-row
  mapping, gated by `utils/validation`'s structural check (never stores an
  invalid/malformed response). There is no separate JSON Schema file for this — the
  hand-written validator in `utils/validation` is the single source of truth, matching
  Workspace 1's own dependency-free style; a schema file would only drift out of sync
  with it, which is exactly what happened before it was removed.
- `utils/errors/` — the `ProposalError` class and error code catalog used everywhere so
  every function returns the same `{success:false, error:{code,message}}` shape without
  leaking internals.
- `utils/logging/` — structured, single-line log helper (never logs secrets or raw
  document content).
- `utils/validation/` — dependency-free structural validation of the Zia response.
- `utils/user-context/` — the one place every function resolves "who is calling," via
  `requireWorkdriveSession(req)`: verifies the signed session token the frontend sends
  as `Authorization: Bearer <token>` (or `?session_token=` for browser navigations, e.g.
  the OAuth callback redirect) and resolves it to the salesperson's email. No Catalyst
  login anywhere — Zoho's own WorkDrive OAuth is the only identity check. Never trusts a
  `user_id`/email from the request body. Scoped to Workspace 2 only — Workspace 1
  functions never call this and stay fully anonymous.

## Dependencies functions need to declare

- `proposal-processor`: `mammoth`, `pdf-parse`, `pdf2json`, `pdfjs-dist`, `xlsx`
  (the first four already exist as a proven set in `functions/spikra_document_process`;
  only `xlsx` is new).
- All Workspace 2 functions: `zcatalyst-sdk-node` (auth/workdrive services otherwise
  use only Node built-ins — `https`, `crypto`, `url`).

## Routing lesson (applies to every future multi-route Workspace 2 Advanced I/O function)

Confirmed live, not assumed: when an Advanced I/O function is called through the API
Gateway, `req.url`'s **pathname** is always stripped down to `/` inside the function,
regardless of which `source_endpoint` was used to reach it — only the query string
survives. So multiple logical "routes" behind one function (like
`proposal-workdrive-auth-v2`'s status/authorize/callback) must be distinguished by
query parameters, never by path segments — exactly how `spikra_experience_deploy`
(Workspace 1, Function 5) already does it for its own multiple GET behaviors. Don't
rediscover this the hard way again.

## What's not yet verified live

- `services/auth/index.js` and `services/workdrive/index.js`'s exact Zoho OAuth/API
  shapes (including `revokeToken`'s response shape) — need one real authorization + one
  real API call once `WORKDRIVE_OAUTH_CLIENT_ID`/`SECRET`/`REDIRECT_URI`/
  `WORKDRIVE_SESSION_SECRET` exist and the `W2_USER_WORKDRIVE` Data Store table has been
  created.
- `services/zia/index.js`'s `extractUsage()` — needs one real call to the Workspace 2
  Zia Agent to confirm whether token usage is actually present in its response, and
  under what field names.

Both are called out explicitly rather than assumed, per the project's standing rule:
verify against a real response before trusting a payload/response shape.
