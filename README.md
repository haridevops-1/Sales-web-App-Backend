# Spikra Internal Sales Hub

Zoho Catalyst (Node.js 22) backend plus two Catalyst Slate web apps, hosting two independent pipelines:

- **Workspace 1 — Customer Showcases**: upload a technical/BRD document (from your computer or your Zoho WorkDrive), get back an interactive, Spikra-branded customer showcase link.
- **Workspace 2 — Solution Proposals**: build a private discovery session from local files or WorkDrive, get back a structured solution proposal (technical, commercial and terms documents).

Both pipelines share the same shape (gather → extract → analyse with a dedicated Zia Agent → render → publish → shareable link) but use separate functions, Data Store tables, Stratus buckets, Zia Agents and Slate apps. The Zoho WorkDrive sign-in is shared.

## Architecture: two Catalyst projects

| Project | Repository | Contains |
|---|---|---|
| **Spikra-AI-Proposal** (backend) | this repo | the APIs (Catalyst functions), the Data Store, and two small Slate apps that serve the **public share links** for each workspace |
| **Internal-Sales-App** (frontend) | `Sales-Web-App-Frontend` (React + Vite, Slate `sales-web-app-frontend`) | the signed-in workspace UI at `spikra-ai-proposal-app.onslate.com` |

- Users work in the React app. It signs them in through this backend (`/auth/*`) and calls the APIs with the session token.
- When a showcase or proposal is published, the backend builds its shareable URL on its own Slate apps: `spikra-ai-proposal.onslate.com/?slug=...` (Customer Showcases) and `spikra-w2-proposal-jmdbymcs.onslate.com/?proposal_id=...` (Solution Proposals). Those pages need no sign-in; they only render the published document.
- All three origins are in `ALLOWED_ORIGINS` and the project's Authorised Domains. Only the React app starts sign-in.

## Layout

```
functions/                  Catalyst functions (one folder each, deployed independently)
  spikra_document_upload/     W1  upload (multipart, or WorkDrive file id) + job creation
  spikra_document_process_v2/    W1  text extraction
  spikra_ai_analysis_v2/      W1  Zia Agent bridge (responds immediately, finishes in the background; poll it)
  spikra_experience_generate_v2/ W1  pure template renderer (no AI)
  spikra_experience_deploy/   W1  publish + public showcase endpoint
  spikra_process_status_v2/      W1  status polling
  spikra_experience_list_v2/     W1  list showcases
  proposal-discovery/         W2  discovery sessions and files (private per signed-in user)
  proposal-processor/         W2  extract → Zia Agent → render proposal documents
  proposal-api/               W2  proposal list/status (signed in) + public document view
  app-auth/                   Shared  Zoho sign-in (OAuth) and app sessions
  workdrive-auth/             Shared  Zoho WorkDrive connection + file browsing

shared/                     W1 shared source        ┐
workspace2-proposal/        W2 shared source        │  the ONLY place to edit shared code;
shared-auth/                Sign-in, sessions, WorkDrive │  copies inside functions/ and slate/ are
frontend-shared/            viewer helpers + styles │  generated (git-ignored)
templates/                  Showcase master template┘
slate/spikra-experience/    public showcase link page (see slate/README.md)
slate/spikra-w2-proposal/   public proposal link page (see slate/README.md)
scripts/sync-shared.js      Copies shared code into each function / Slate app
Unused/                     Retired functions kept for reference (not deployed)
catalyst.json, catalyst-user-rules.json   Project targets and API Gateway routes
```

Catalyst packages each function directory on its own, so shared code must be copied in. `scripts/sync-shared.js` does that from a manifest; never edit the generated copies.

## Deploying

```bash
npm run deploy          # secret check, sync shared code, then `catalyst deploy --only functions,apig,slate`
npm run check:shared    # fails if any generated copy is stale
npm run check:secrets   # fails if a credential-looking value or a secret in a function config is found
```

A bare `catalyst deploy` skips the sync step — use `npm run deploy` (or run `npm run sync:shared` first). On a fresh clone the generated copies do not exist until you sync.

### One-time setup

1. **Data Store tables** (already created in the Development environment; create the same three in Production): `APP_USERS` (`email` unique, `display_name`, `zuid`, `status`, `last_login_at`, `wd_row_id`), `APP_SESSIONS` (`user_row_id`, `email`, `display_name`, `wd_row_id`, `token_hash`, `expires_at`, `status`) and `WORKDRIVE_CONNECTIONS` (`user_email`, `wd_email`, `display_name`, `access_token`, `refresh_token`, `expires_at`, `scope`, `region`, `status`). Existing app tables are unchanged.
2. **Zoho API Console client** (Server-based Application). Redirect URIs, exactly: `<api-domain>/auth/callback` and `<api-domain>/workdrive/callback`. Scopes used: `AaaServer.profile.READ` (sign-in) and `WorkDrive.files.READ, WorkDrive.users.READ, WorkDrive.teamfolders.READ, ZohoFiles.files.READ, AaaServer.profile.READ` (WorkDrive).
3. **Authorised Domains** (CORS): the three app origins: `spikra-ai-proposal-app.onslate.com` (the main React app, repo `Sales-Web-App-Frontend`, in the separate *Internal-Sales-App* Catalyst project), `spikra-ai-proposal.onslate.com` and `spikra-w2-proposal-jmdbymcs.onslate.com` (the Slate apps in this repo). The same origins are in `ALLOWED_ORIGINS` in each function's `catalyst-config.json`. Remove any other domain from the Console list.
4. **Per-environment values** (bucket names, Zia connection name, URLs) are in each function's `catalyst-config.json` and read from the environment; nothing environment-specific is hardcoded in code. **Secrets, set in the Console only** (never in `catalyst-config.json` or git); `.env.example` lists which function needs which: `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`, `STATE_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEY` (the last two random and different: `openssl rand -hex 32`). Functions refuse to run without them; there are no defaults.
5. **Who may sign in**: `ALLOWED_EMAIL_DOMAINS` (default `spikra.com`) in `functions/app-auth/catalyst-config.json`.
6. **Basic I/O → Advanced I/O**: the four Workspace 1 functions that were Basic I/O (`spikra_document_process`, `spikra_experience_generate`, `spikra_process_status`, `spikra_experience_list`) are replaced by Advanced I/O versions with a `_v2` suffix, because Catalyst cannot change a function's type in place and Basic I/O code cannot check the sign-in token. The gateway rules point at the `_v2` functions, so the frontend is unchanged. The old versions are kept in `Unused/` (not deployed); delete the old live functions in the Console once the new ones are verified.
7. Edit `slate/*/config.js` if the API base URL changes (it is the public gateway URL, not a secret).

## How sign-in works

Two separate things, so users approve each only once.

**1. App sign-in (Zoho Accounts).** The app sends the browser to `/auth/login`, which redirects to Zoho. Zoho's own login page is the identity check. On return, `/auth/callback` exchanges the code, reads the account's email, rejects any email whose domain is not in `ALLOWED_EMAIL_DOMAINS`, creates or updates the user in `APP_USERS`, opens a session in `APP_SESSIONS`, and redirects back to the app with an opaque session token in the URL *fragment* (never sent to a server or logged). The browser keeps it in `sessionStorage` and sends `X-Session-Token: <token>`. Sessions are server-side: only a SHA-256 hash of the token is stored, they last 7 days, and sign-out or disabling a user (`APP_USERS.status` ≠ `ACTIVE`) invalidates them immediately. Opening the app in a new tab needs one click; Zoho signs the user in silently.

**2. WorkDrive connection (only when picking files from WorkDrive).** "Connect Zoho WorkDrive" sends the signed-in user to Zoho's consent page once. The refresh token is encrypted (AES-256-GCM) and stored in the user's `WORKDRIVE_CONNECTIONS` row, so it survives sign-out, new tabs and new browsers and Zoho is **not asked again** until the user presses Disconnect (which wipes the stored tokens and revokes the grant at Zoho). Local file uploads never need WorkDrive.

The connect step is bound to the signed-in browser: the authorize call returns a one-time secret the browser keeps privately, the state embeds its hash plus the user, and the final `POST /workdrive/connect` must present all three. A forged link therefore cannot attach someone else's WorkDrive to an account. Zoho hosts are taken only from a fixed region table, so the client secret can never be sent to a request-supplied host.

Every API except the public share links requires a signed-in user. The signed-in UI lives in the separate React app (see Architecture); it sends users to `/auth/login` and sends the token in `X-Session-Token`.

## Workspace 1 pipeline (driven by the React app)

`upload` → `process` → `analyze` (poll until `still_processing` is false) → `generate` → `deploy` → public link `…/?slug=<slug>`. The app shows a step-by-step progress view and lets a failed step be retried. `process`, `generate` and `status`/`list` calls use query-string arguments so browsers send them as simple (non-preflighted) requests; `analyze` and `deploy` send JSON and have OPTIONS routes.

## AI architecture

- Each workspace has its **own Zia Agent**; both authenticate through the Catalyst Connection named in config. No API key or token for either is stored in this repository.
- **No function calls Claude, Anthropic, OpenAI or any LLM directly, and no LLM key exists in the code, config, frontend or `.env.example`.** Model choice lives inside the Zia Agent (Zia Agent Studio).
- Function 3 is the only Catalyst → Zia bridge; Function 4 is a pure renderer. Spikra controls the design; the model never chooses layout.
- **No fabrication**: agent output is structurally validated and rejected if empty or off-schema; normalisation only trims and caps, never invents content. Token usage is recorded only when the agent reports it.

## Security notes

- **Secrets**: none in the repo. If a credential was ever committed, rotating it is required; deleting the line does not remove it from git history. (The earlier WorkDrive client secret and keys were committed and must be rotated, see below.)
- **Sessions**: opaque random tokens, hash-only storage, constant-time comparison, 7-day expiry, instant revocation; read only from headers.
- **WorkDrive tokens**: AES-256-GCM at rest; wiped on disconnect.
- **Data Store access**: all tables grant the `App User` role no permissions; only server code (admin scope) reads or writes them. Keep it that way for any new table.
- **CORS**: strict allow-list from `ALLOWED_ORIGINS`; unknown origins receive no CORS headers. Redirects only ever go to an allow-listed origin named in the signed state.
- **Public endpoints (intentional)**: the showcase and proposal *view* links are readable by anyone who has the link or id; they are the shareable artefacts. Everything else needs sign-in. Add API Gateway throttling on `/auth/login` if exposed beyond staff.
- **Frontend**: the React app keeps the session token in `sessionStorage` only and attaches it centrally; the public link pages render generated documents in a sandboxed `iframe` that cannot navigate the parent and write server text with `textContent` only.

### Credential rotation checklist

1. Zoho API Console → regenerate the client secret.
2. Generate two new random values for `STATE_SIGNING_SECRET` and `TOKEN_ENCRYPTION_KEY`. Changing `TOKEN_ENCRYPTION_KEY` makes stored WorkDrive tokens unreadable, so users reconnect WorkDrive once (intended after a leak).
3. Set all four in the Console on every function that needs them.
4. Optionally purge the old values from git history (`git filter-repo`) and force-push; until then treat them as public.

## Environment

See `.env.example` for every variable, which are secret, and where each is set. Non-secret values live in each function's `catalyst-config.json`.

## Clean-up checklist for the Catalyst Console

Resources that exist in the Development project but are no longer part of this codebase (the CLI cannot remove them and no tool here can). Delete them once the new version is deployed and verified:

- Functions: `proposal-workdrive-auth-v2`, `proposal-agent` (replaced by `workdrive-auth` / `proposal-processor`).
- Data Store table: `W2_USER_WORKDRIVE` (replaced by `WORKDRIVE_CONNECTIONS`).
- The four old Basic I/O functions (`spikra_document_process`, `spikra_experience_generate`, `spikra_process_status`, `spikra_experience_list`) once their `_v2` replacements are verified. Their source is kept in `Unused/`.
- API Gateway rule `spikra-experience-list-post-api` (GET is used).
- Review, then remove if unused: the Client web app `internal-sales-app` and its `Login Redirect` route (not part of this repository).

## Cutover runbook (first release of sign-in)

The new backend and the new React app must go live together: the old app has no sign-in and would get 401s from the new backend, and the new app cannot sign in against the old backend.

1. Slate (frontend project) → `sales-web-app-frontend` → turn **Auto Deploy** off.
2. `npm run deploy` here. It creates `app-auth` and the four `_v2` functions and re-points the gateway rules; the old Basic I/O functions stay in place, unused.
3. In the Console, confirm each function's variables (secrets from `.env.example` plus the values from `catalyst-config.json`). On `app-auth` set `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET` and a new `STATE_SIGNING_SECRET`.
4. Push the backend, merge and push the frontend branch `feat/zoho-sign-in`, then **Sync Now** in Slate.
5. Sign in, upload one file, connect WorkDrive once, reload (Zoho must not ask again). Turn Auto Deploy back on.
6. Delete the four old Basic I/O functions, then retire the old Web Client (`internal-sales-app`) and its *Login Redirect* route.

## Deploys reset function variables

`catalyst deploy` replaces each function's environment with exactly what is in its `catalyst-config.json`, so **every deploy removes the secrets** set in the Console (`ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`, `STATE_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEY`). After each deploy, set them again on the functions that need them (see `.env.example` for which), or deploy only what changed: `catalyst deploy --only functions:<name>` resets just that function. Until they are set, the functions fail closed with a configuration error and sign-in is unavailable.
