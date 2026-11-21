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
- Linking an `.html` artifact in a chat message with `?embed=1` (and optional `&version=N`) on its
  own line renders it flush inline right at that spot inside the message stream on the same isolated
  `a-<uuid>.<sandbox host>` origin. The runtime sets `data-display-mode="inline"` and
  `data-expanded`, applies host `--coforge-*` theme and font variables with transparent `14px` body
  defaults, and reports content height (`ui/notifications/size-changed`, clamped to 96px–800px, up
  to 896px wide; once settled at a given width the frame holds its high-water height to avoid
  tab-switch layout jumps until the container width changes). Active inline frames are lazily
  activated in the viewport and bounded per conversation by an LRU pool.

## Publish check

Enabled by default across local Compose, staging, and production via the isolated Playwright
sidecar (`services/artifact-checker/`). Pushing an `.html` artifact schedules an asynchronous
`pg-boss` job that renders the version across four viewports (`desktop` 1280×800, `phone`
390×844 @2x, `inline` 896×800 light, and `inline-dark` 896×800 dark with `--coforge-*` tokens)
under the same CSP and CDN allowlist, and `coforge artifact push` prints the next
`coforge artifact check` command right after `Open:`:

- `coforge artifact check <id> [--rev <n>] [--wait] [--output <dir>] [--json]` prints findings
  (console errors, blocked requests, broken images, missing artifact 404 assets, blank page, phone
  horizontal overflow, inline height clipping above 800px, and CSS scroll locks) and downloads PNG
  screenshots into `.coforge-check/`.
- Screenshots are retained in `artifact-blobs` for the newest 3 completed versions per artifact;
  older versions keep their findings while older screenshot blobs are released.
- Workspaces default to a rolling 24-hour cap of 200 publish checks
  (`COFORGE_ARTIFACT_CHECK_DAILY_CAP`, `0` for unlimited); pushes beyond the cap record
  `skipped (workspace_daily_cap)`.
- In custom setups where `COFORGE_ARTIFACT_CHECK_WORKER_URL` is unset, checks degrade cleanly to
  disabled and Agent prompts omit the check step.
