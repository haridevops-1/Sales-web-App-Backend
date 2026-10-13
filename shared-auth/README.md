# shared-auth

Source of truth for sign-in, sessions and the Zoho WorkDrive connection, used by both workspaces. It is never deployed as-is: `scripts/sync-shared.js` copies it into every function (see the manifest there). Edit it here, then run `npm run sync:shared`.

## Modules

- `utils/config` — environment access. `requireEnv` fails closed (no defaults); `ZOHO_REGIONS` is the only source of Zoho accounts/API hosts; `allowedOriginOrNull` checks `ALLOWED_ORIGINS`; `emailDomainAllowed` checks `ALLOWED_EMAIL_DOMAINS`.
- `services/auth` — Zoho OAuth 2.0 primitives (authorize URL, HMAC-signed 10-minute state, code exchange, refresh, revoke, `/oauth/user/info`) and the AES-256-GCM helpers for tokens at rest.
- `services/users` — `APP_USERS` / `APP_SESSIONS`. `loginUser` creates the user (and their empty `WORKDRIVE_CONNECTIONS` row) on first login, enforces `ACTIVE`, and opens a session. A session token is `<APP_SESSIONS rowId>.<random secret>`; only `sha256(secret)` is stored. `authenticate` reads the session and user rows by id (consistent immediately, unlike ZCQL), checks status, hash and expiry. `revokeSession` ends a session.
- `utils/session` — `requireSession(app, req)` resolves the signed-in user from the `Authorization: Bearer` header or throws a 401. There is no default identity and tokens are never read from the URL.
- `services/workdrive` — WorkDrive client for one user, backed by their `WORKDRIVE_CONNECTIONS` row: `getConnectionStatus`, `saveConnection`, browsing (`listRootItems`, `listFiles`, `findBusinessFolder`), `getFileMetadata`, `downloadFile` (25 MB cap), `disconnectConnection` (wipes tokens, revokes at Zoho). Access tokens are refreshed from the stored refresh token and persisted, so the user is not asked to approve again. WorkDrive problems return **403** (`WORKDRIVE_NOT_CONNECTED` / `WORKDRIVE_TOKEN_EXPIRED`), never 401, so the app can tell them apart from an ended app session.
- `utils/advanced-adapter` — `requireAuth(handler)` wraps an Advanced-I/O function so it needs a signed-in user (public methods can be exempted); `asAdvancedIO(handler)` runs a Basic-I/O style `(context, basicIO)` handler behind sign-in.
- `utils/errors` — `WorkdriveError` and the error-code catalogue; `toErrorResponse` is duck-typed so Workspace 2's `ProposalError` can reuse it.

## Data Store tables

| Table | Columns |
|---|---|
| `APP_USERS` | `email` (unique), `display_name`, `zuid`, `status` (`ACTIVE`/`DISABLED`), `last_login_at`, `wd_row_id` |
| `APP_SESSIONS` | `user_row_id`, `email`, `display_name`, `wd_row_id`, `token_hash`, `expires_at`, `status` (`ACTIVE`/`REVOKED`) |
| `WORKDRIVE_CONNECTIONS` | `user_email`, `wd_email`, `display_name`, `access_token` (text, encrypted), `refresh_token` (text, encrypted), `expires_at`, `scope`, `region`, `status` (`NOT_CONNECTED`/`CONNECTED`/`DISCONNECTED`/`EXPIRED`) |

To block a user: set `APP_USERS.status` to `DISABLED`; their sessions stop working on the next request. Expired session rows are not purged automatically; delete rows with an old `expires_at` periodically.

## Routes

`functions/app-auth`

| Method | Route | Auth | Result |
|---|---|---|---|
| GET | `/auth/login?return_to=<origin>` | none | 302 to Zoho (`format=json` returns `{ authorize_url }`) |
| GET | `/auth/callback` | signed `state` | 302 to `<origin>/#sp_token=…` or `#sp_error=…` |
| GET | `/auth/me` | session | `{ user, workdrive: { connected, account } }` |
| POST | `/auth/logout` | session | revokes the session |

`functions/workdrive-auth` (all need a session except the callback)

| Method | Route | Result |
|---|---|---|
| GET | `/workdrive/authorize` | `{ authorize_url, binding }` |
| GET | `/workdrive/callback` | 302 to `<origin>/#wd_code=…&wd_state=…` (stores nothing) |
| POST | `/workdrive/connect` | body `{ code, state, binding }`; verifies state + user + binding, exchanges the code, stores the connection |
| GET | `/workdrive/status` | `{ connected, account }` |
| POST | `/workdrive/disconnect` | wipes tokens, revokes at Zoho |
| GET | `/workdrive/list?folder_id=` / `?query=` | root, folder or client-folder search |
| GET | `/workdrive/metadata?file_id=` | normalised file info |

Downloading bytes is an internal call (`downloadFile`) used by the upload and discovery functions; there is no public download route.

## Required environment

Secrets (Console only): `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`, `STATE_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEY`. Non-secret: `ZOHO_LOGIN_REDIRECT_URI`, `ZOHO_WORKDRIVE_REDIRECT_URI`, `ZOHO_ACCOUNTS_DOMAIN`, `ALLOWED_ORIGINS`, `ALLOWED_EMAIL_DOMAINS`. See `.env.example` for which function needs which.

## Not yet verified against live Zoho

Nothing here has been run against a real account. Confirm one full sign-in, one WorkDrive connect (including the team-folder and private-space listing in `listRootItems`) and one disconnect.
