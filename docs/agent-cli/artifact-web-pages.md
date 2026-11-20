# Artifact web pages

What an artifact whose entry is an `.html` file may load, and how it is served. The commands are in [Artifacts](artifacts.md).

## What a web page may load

A page of artifact `<uuid>` is served only from `a-<uuid>.<sandbox host>`, so its storage is its own
and no other artifact shares it. The origin serves every file of the opened version under a file
token's path (`/_f/<token>/<path>`), so relative references (`css/site.css`, `img/a.png`, a link to
`other.html`) resolve inside the artifact:

- An `.html` file is a document only for a frame or a tab, under the page's CSP and with the page
  runtime injected first; any other file only as a subresource, a `fetch` or a worker script. A
  file of another version or artifact is not reachable through the token.
- A link is a single-use ticket: opening it spends it and redirects to the entry under a file
  token. A used or expired ticket shows a small page and tells the framing app, which offers a
  reload. The token's files work for 10 minutes and are cached for that long (a public link's for
  one minute); `.html` documents are never cached.
- A page may load scripts and styles from a fixed set of public hosts (cdnjs.cloudflare.com,
  cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, code.jquery.com, cdn.plot.ly), web fonts
  from fonts.googleapis.com and fonts.gstatic.com, and images and fonts from those CDNs, and
  may `fetch` those hosts and its own files. The list is `SANDBOX_PUBLIC_CDNS` in
  `apps/web/src/server/artifacts/artifact-sandbox-cdns.server.ts`.
- It makes no other network requests (no WebSocket, no form, no window, no nested frame), and has no
  cookies of ours; `localStorage` and IndexedDB belong to its artifact's origin.
- The page runtime exposes `window.coforge.use(name)`: `user`, `artifact`, `clipboard`, `links`,
  `downloads`, `db`, `assets`, and (in `panel` mode) `comments`, answered by the app's page over
  `postMessage` (the Manual's `artifact-pages` topic lists them). An `.html` file is read whole by
  the sandbox and may be at most 2 MiB to be shown.
- Linking an `.html` artifact in a chat message with `?embed=1` (and optional `&version=N`) renders
  it flush inline inside the message stream on the same isolated `a-<uuid>.<sandbox host>` origin.
  The runtime sets `data-display-mode="inline"`, applies host `--coforge-*` theme variables and
  transparent defaults, and reports content height (`ui/notifications/size-changed`, clamped to
  96px–800px). Active inline frames are lazily activated in the viewport and bounded per
  conversation by an LRU pool.

## Publish check

When the isolated Playwright sidecar (`services/artifact-checker/`, configured via
`COFORGE_ARTIFACT_CHECK_WORKER_URL` and `COFORGE_ARTIFACT_CHECK_SECRET`) is enabled, pushing an
`.html` artifact schedules an asynchronous `pg-boss` job that renders the version across three
viewports (`desktop` 1280×800, `phone` 390×844 @2x, and `inline` 672×800 with light `--coforge-*`
tokens) under the same CSP and CDN allowlist:

- `coforge artifact check <id> [--rev <n>] [--wait] [--output <dir>] [--json]` prints findings
  (console errors, blocked requests, blank page, phone horizontal overflow, inline height clipping
  above 800px, and CSS scroll locks) and downloads PNG screenshots into `.coforge-check/`.
- Screenshots are retained in `artifact-blobs` for the newest 3 completed versions per artifact;
  older versions keep their findings while older screenshot blobs are released.
- When `COFORGE_ARTIFACT_CHECK_WORKER_URL` is unset, checks stay disabled and Agent prompts omit
  the check step.
