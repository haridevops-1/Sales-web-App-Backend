# shared-workdrive

Zoho WorkDrive OAuth + file browsing, shared by both Workspace 1 (Customer Showcases)
and Workspace 2 (Solution Proposals). This is source code only — it is never deployed
as-is. Each Catalyst function that needs it (`functions/workdrive-auth`,
`functions/proposal-api`, `functions/proposal-discovery`, `functions/proposal-processor`,
`functions/spikra_document_upload`) copies this whole folder into its own
`shared-workdrive/` subfolder at build time and requires it with a local-first fallback:

```js
let requireSession, workdrive;
try {
  ({ requireSession } = require("./shared-workdrive/utils/session"));
  workdrive = require("./shared-workdrive/services/workdrive");
} catch {
  ({ requireSession } = require("../../shared-workdrive/utils/session"));
  workdrive = require("../../shared-workdrive/services/workdrive");
}
```

This mirrors exactly how Workspace 1's `shared/` and Workspace 2's `workspace2-proposal/`
are consumed — required because Catalyst deploys each function's directory in isolation,
with nothing outside it included. It lives in its own `shared-workdrive/` subfolder
(not the pre-existing `shared/`) inside each Workspace 2 function specifically to avoid
colliding with `workspace2-proposal/utils/errors` — a different, Workspace-2-specific
`ProposalError` class that already occupies `shared/utils/errors` in those functions.

## Why real OAuth 2.0, not a Catalyst Connection

A Catalyst Connection returns one shared credential set for every caller — it can't
represent "salesperson A's WorkDrive files vs salesperson B's." Each salesperson
connects their own Zoho account, so their access token has to be looked up per-email,
not shared. There is no separate app login: clicking "Open WorkDrive" goes straight to
Zoho's own login/consent page, and that success IS the identity check — the same
"Login with X" pattern any third-party-OAuth app uses.

## Layout

- `services/auth/` — `buildAuthorizeUrl`, `verifyState`, `exchangeCodeForToken`,
  `refreshAccessToken`, `revokeToken`, `fetchZohoUserInfo`. Builds the authorize URL
  (`state` is a plain CSRF nonce, carries no identity), exchanges the code, looks up the
  salesperson's email via `fetchZohoUserInfo`, issues/verifies the app's own signed
  session token (`issueSessionToken`/`verifySessionToken`, tied to that email, 30-day
  TTL, secret from `WORKDRIVE_SESSION_SECRET`), and encrypts/decrypts the OAuth tokens
  at rest (AES-256-GCM, separate key from `WORKDRIVE_TOKEN_ENCRYPTION_KEY` — a leak of
  one secret should not automatically compromise the other).
- `services/workdrive/` — WorkDrive API client backed by the `WORKDRIVE_CONNECTIONS`
  table, keyed by the salesperson's Zoho email (not a Catalyst identity — there isn't
  one). Resolves a valid access token per email (via `services/auth`, refreshing
  transparently before every call), never a Connection. Also provides real file
  browsing — `listRootItems`, `listFiles(folderId)`, `getFileMetadata(fileId)`,
  `downloadFile(fileId)` (returns `{ buffer, fileName, mimeType }` so a WorkDrive file
  can be treated exactly like a locally-uploaded one) — and disconnect (best-effort
  revoke at Zoho's end, then marks the row disconnected locally either way). Endpoint
  paths are marked `VERIFY` until confirmed against a real response.
- `utils/session/` — the one place every consuming function resolves "who is calling,"
  via `requireSession(req)`: verifies the signed session token the frontend sends as
  `Authorization: Bearer <token>` (or `?session_token=` for browser navigations, e.g.
  the OAuth callback redirect) and resolves it to the salesperson's email. **Throws** a
  401-flavored `WorkdriveError` on a missing, malformed, or expired token — it never
  falls back to a default identity. (An earlier, Workspace-2-only version of this file,
  `requireWorkdriveSession`, had exactly that bug: every request with no/invalid token
  silently became `hariharan@spikra.com`. Fixed here, not carried forward.)
- `utils/errors/` — the `WorkdriveError` class and error code catalog. `toErrorResponse`
  is duck-typed on `{code, statusCode}` rather than `instanceof WorkdriveError`, so a
  caller with its own similarly-shaped error class (Workspace 2's `ProposalError`) can
  recognize and correctly format an error thrown from here without a cross-module class
  dependency — see `workspace2-proposal/utils/errors`'s `toErrorResponse`.

## The `WORKDRIVE_CONNECTIONS` table

One salesperson per row: `email` (lookup key), `display_name`, `access_token`
(encrypted), `refresh_token` (encrypted), `expires_at`, `scope`, `status`
(`CONNECTED`/`DISCONNECTED`/`ERROR`). Created manually in the Catalyst Data Store
console (org Spikra, project Spikra-AI-Proposal) — not created by code.

## `functions/workdrive-auth`

The only function with public WorkDrive routes (Advanced I/O; query-string routing,
since Advanced I/O behind the gateway always sees `req.url`'s pathname stripped to `/`
regardless of `source_endpoint`):

| Method | action | Route |
|---|---|---|
| GET | `code`/`state` present | OAuth callback → exchange code, fetch email, upsert `WORKDRIVE_CONNECTIONS`, issue session token, `postMessage` back to the opener window |
| GET | `action=authorize` | Returns `{ authorize_url }` |
| GET | `action=status` (default) | The one deliberately anonymous-friendly route — no session yet is not an error, just `{ connected: false }` |
| POST | `action=disconnect` | Requires session → revoke + mark `DISCONNECTED` |
| GET | `action=list` | Requires session → `?folder_id=` optional → list files/folders (root if omitted) |
| GET | `action=metadata` | Requires session → `?file_id=` → single file/folder metadata |

`download` is intentionally **not** a public route — it stays an internal
`services/workdrive.downloadFile` call used by the consuming workspace functions when a
picked file actually needs its bytes.

## What's not yet verified live

Every WorkDrive endpoint path here (`services/auth`, `services/workdrive`) follows
Zoho's publicly documented API v1 shape but has never been exercised against a real
Zoho account — `WORKDRIVE_OAUTH_CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI` don't exist
yet (manual Zoho API Console step). Confirm against one real authorize → callback →
list/download round trip once those exist and the `WORKDRIVE_CONNECTIONS` table has
been created, per the project's standing rule: verify against a real response before
trusting a payload/response shape.
