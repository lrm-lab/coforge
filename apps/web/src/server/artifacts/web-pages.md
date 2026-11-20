# Web pages and their origins

- A page of artifact `<uuid>` is served only from `a-<uuid>.<sandbox host>`, matched by host name
  alone (`artifact-sandbox-config.server.ts`). Every name under the sandbox host belongs to the
  sandbox. The bare sandbox host accepts only legacy `GET` and `HEAD` requests to `/p/<token>`.
  A valid token redirects to the application's public reader without the token or query string.
  The application host must be outside the sandbox domain (a boot rule). Locally the sandbox is
  `http://localhost:<port>` and the application runs on `127.0.0.1`.
- Opening is two signed values (`artifact-sandbox-ticket.server.ts`): a ticket, single use (its
  nonce is spent through `TicketNonces`: Redis `SET NX EX`, an in-process map only without Redis;
  an unspendable nonce refuses the ticket, never opens it), then a file token in the path
  (`/_f/<token>/<path>`) good for 10 minutes. A path, not a cookie: the page is a third-party frame
  and a browser may refuse it cookies. Both name the origin they are for and are refused on any
  other. A used or expired ticket, and an expired file token asked for a frame document (a page or a
  PDF reloaded after 10 minutes), answer a small page that posts a
  `coforge/notifications/frame-status` message to the embedder origin only; the viewer then offers
  to reload, the PDF frame included.
- The page's CSP and headers live in `artifact-sandbox-response.server.ts`; hosts a page may load
  from live only in `artifact-sandbox-cdns.server.ts`. A nonce or hash in `script-src` would turn
  `'unsafe-inline'` off, so the runtime (`artifact-page-runtime.server.ts`) is a script file of the
  page's own origin, injected first.
- A ticket may name one file (`p`: an html file or a PDF the version holds; `link({ path })`), and
  opening redirects to it, so a non-entry page is served exactly as the entry is: same origin,
  sandbox flags, CSP, runtime and bridge, and relative links resolve against its own path under
  `/_f/<token>/`. A path the version lacks, or that is neither, is `NOT_FOUND`.
- A PDF is served as a frame document only under a file token (never on a public link): bytes with
  `Content-Type: application/pdf`, `nosniff`, and a policy of `default-src 'none'` plus the host
  as the only frame ancestor, `no-store` like a page, no runtime and no bridge. Its frame carries no `sandbox` attribute, because Chrome
  refuses to render a PDF in a sandboxed frame; the origin is the artifact's own, holds no
  credential, and serves nothing else to that frame. The document read re-checks access like a page.
- A public link to an entry that is neither a web page nor Markdown redirects to
  `/p/<token>/file/<entry>` and serves that path only. Text and CSV (up to 1 MiB; a CSV of at
  most 50,000 cells) are drawn into an escaped static page, and an image (up to 8 MiB) into a page
  whose `<img>` is the one image request answered with the bytes. Anything else, a PDF included,
  gets a page asking the visitor to sign in, without reading the bytes.
- A page reader's access is checked on the ticket and on each page document; a subresource serves
  under its file token until the token expires. Do not widen who can read in this module; call
  `ArtifactReads` as it is.
- The runtime's annotation layer (`artifact-page-annotate-runtime.server.ts`, locating anchors in
  `artifact-page-annotate-locate-runtime.server.ts`) draws in an overlay
  element of its own (a layer apart from find) and never changes the page's own nodes; it answers the
  host's `coforge/annotate/*` messages only from the host window and origin. The page shares the
  frame, so none of this is a boundary against the page: it can read or patch the overlay and post
  what it likes to the host, which treats everything from the frame as untrusted. Its quote logic is
  generated from `features/artifacts/artifact-text-anchor.ts` (`createTextAnchors`, one source;
  `artifact-page-annotate-text.test.ts` smoke-tests the generated snippet). The `coforge` object
  offers no annotate method. Its `comments.open(anchor, { draft })` is built in (no declaration): the
  frame checks the user activation, and the host checks it again with its own
  `navigator.userActivation` (a click in the frame activates the top window too), then validates the
  arguments, applies the 30 a minute limit and refuses (`false`) while a composer holds text or a
  send or another ask is open; it opens only a composer, never posts.
  The Vite dev server answers a script request for `/_coforge/runtime.js` with its own 404, so a
  browser e2e that needs the runtime in the real app runs against a built Web (as CI does).
- Known gaps, pinned in `test/artifact-sandbox-browser.e2e.ts`: resource hints still reach out, and
  so does a WebRTC constructor taken from an `about:blank` frame the page makes: every HTML
  document carries `webrtc 'block'` (the frame inherits it) and the runtime removes the page's own
  constructors, but Chrome 157 does not enforce the directive. Flip the test when a browser does.
