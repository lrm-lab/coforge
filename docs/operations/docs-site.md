# Docs site deployment

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
  ([runbook](cdn-certificates/renewal.md)).
