# Slate apps: public share links

Two static Catalyst Slate apps, each deployed once. They only serve the **public links** the backend publishes; the signed-in workspace UI is the React app in the separate *Internal-Sales-App* project (repo `Sales-Web-App-Frontend`). Plain HTML/CSS/JS, no build step, no sign-in, no dependencies.

```
slate/<app>/
  index.html            entry point
  404.html              GENERATED copy of index.html (path-style links such as /<slug>)
  config.js             environment settings (public API gateway URL); the only file to edit per environment
  assets/js/viewer.js   reads the link, fetches the published document, shows it
  assets/shared/        GENERATED from ../frontend-shared (viewer helpers + styles)
  client-package.json, .catalyst/   Slate deployment files
```

| App | Link format | Fetches |
|---|---|---|
| `spikra-experience` | `/?slug=<slug>` (or `/<slug>`) | `GET /spikra/experience/deploy` |
| `spikra-w2-proposal` | `/?proposal_id=<id>&type=<technical\|commercial\|tos>` | `GET /proposal/api?resource=view` |

Both endpoints are the backend's only public routes. The document is rendered in a sandboxed `iframe` that cannot navigate the parent page, and server text is written with `textContent` only.

## Shared code

`frontend-shared/` is the only place to edit shared viewer code (`js/viewer-core.js`, `css/viewer.css`). `npm run sync:shared` (also run by `npm run deploy`) copies it into each app's `assets/shared/` and regenerates `404.html`. Generated files are git-ignored (except `404.html`).

To change the environment, set `apiBase` in `config.js` and add the matching origin to the functions' `ALLOWED_ORIGINS` and the project's Authorised Domains.
