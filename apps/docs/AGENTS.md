# apps/docs

The public developer documentation site: VitePress 1.6.4 with `vitepress-plugin-llms`, English at `/`
and Simplified Chinese at `/zh-CN/`. It is separate from the web app and deploys as static files.

## Commands

Run from `apps/docs` (the root `mise run test`, `check` and `build` already run them):

- `bun run dev`: local preview.
- `bun run build`: static site into `.vitepress/dist`. VitePress fails the build on a dead internal
  link; do not set `ignoreDeadLinks`. Set `DOCS_ORIGIN` to make `llms.txt` links absolute.
- `bun test`: builds, then checks `llms.txt`, a `.md` twin per page, the schema copy, and that both
  locales have the same page set.
- `bun run check`: format and lint.

## Rules

- Public content for outside developers lives here. Internal contracts stay in `docs/`; a page links
  to the contract on GitHub until the topic moves. A change to a public contract updates the contract
  and its page here in the same commit.
- Every page has front matter with `title` and `description`; the description is its line in
  `llms.txt`. Every page exists in both locales at the same path; translate properly and keep the
  product terms the web app's zh-CN messages use (Workspace is 工作区, App is 应用, Agent stays Agent).
- `vitepress-plugin-llms` publishes a directory's `index.md` as `<dir>.md` (`/apps/` is `/apps.md`).
- The Agent manifest JSON Schema is copied from `docs/agent-manifest/` into `/schemas/` by the build
  (`.vitepress/config.ts` `buildEnd`). Never commit a second copy.
- `public/` holds the logo and favicons. The web app's logo files are separate; do not edit them.

## Deployment

Production only (no docs staging). The `Publish docs site (production)` workflow
(`.github/workflows/docs-production.yml`) is started with `workflow_dispatch` from `main` (every non-CI workflow is dispatch-only; a push to
`main` publishes nothing). After merging, run "Publish docs site (production)" from Actions; it needs
no approval.

- `build` has no secrets: check, test, `DOCS_ORIGIN=https://docs.coforge.cn` build, upload the dist.
- `deploy` runs in the `docs` GitHub Environment (main only, no reviewers) and assumes RAM
  role `coforge-docs-publisher` through GitHub OIDC. `scripts/docs/publish-docs-site.ts` uploads to the
  private bucket `coforge-docs-prod` (cn-beijing) with explicit Content-Type and Cache-Control
  (`site-plan.ts`), assets first and HTML last, deletes objects the dist no longer has (never from an
  empty dist or one without `index.html`), then verifies read-back hashes of `index.html` and
  `llms.txt` and that the unsigned bucket origin answers 403.
- The CDN domain `docs.coforge.cn` reads the bucket; its origin rewrites map `/` and `/dir/` to
  `index.html` and `/page` to `/page.html`. HTML, md, txt, json and xml revalidate on every request;
  `/assets` is cached a year. A page change needs no CDN purge.
- Roll back: dispatch the workflow with `ref` set to an earlier commit or tag (the `Use workflow
from` picker); it rebuilds and republishes that commit's site.
- TLS: the CDN certificate is a Let's Encrypt certificate uploaded by hand, expiring 2027-01-21.
  `docs.coforge.cn` is in `scripts/ops/cdn-certificate-domains.json`, so the scheduled `Renew CDN
certificates` workflow replaces it once under 30 days remain
  ([runbook](../../docs/operations/cdn-certificates/renewal.md)).
