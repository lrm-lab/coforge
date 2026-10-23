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
- Hosting (Alibaba Cloud OSS + CDN at docs.coforge.cn) is not part of this package yet.
