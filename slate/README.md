# Slate web apps

Two static Catalyst Slate apps, each deployed once. Plain HTML/CSS/JS with no build step or dependencies.

```
slate/<app>/
  index.html            entry point; routes to the public viewer or the signed-in workspace
  404.html              GENERATED copy of index.html (path-style links such as /<slug>)
  config.js             environment settings (public API gateway URL); the only file to edit per environment
  assets/js/app.js      workspace UI for this app
  assets/js/viewer.js   public share-link viewer (no sign-in)
  assets/shared/        GENERATED from ../frontend-shared (design system + UI core)
  client-package.json, .catalyst/   Slate deployment files
```

| App | Workspace | Public link |
|---|---|---|
| `spikra-experience` | Customer Showcases: upload, pipeline progress, list | `/?slug=<slug>` |
| `spikra-w2-proposal` | Solution Proposals: discovery sessions, files, generation, proposal status | `/?proposal_id=<id>&type=<technical\|commercial\|tos>` |

## Shared code

`frontend-shared/` is the only place to edit shared UI code:

- `css/spikra.css` — design tokens and components.
- `js/spikra-core.js` — safe DOM helpers (`el`, never `innerHTML`), API client, Zoho sign-in (redirect flow, session in `sessionStorage`), WorkDrive connection and file picker, modals, steppers.

`npm run sync:shared` (also run by `npm run deploy`) copies it into each app's `assets/shared/` and regenerates `404.html`. Generated files are git-ignored (except `404.html`).

## Conventions

- Every API call carries the session token; a 401 returns the user to the sign-in screen. WorkDrive problems arrive as 403 and only affect the WorkDrive features.
- Server-provided text is rendered with `textContent`. Generated documents are shown in a sandboxed `iframe`.
- Set `apiBase` in `config.js` and the matching origins in the functions' `ALLOWED_ORIGINS` when adding an environment.
