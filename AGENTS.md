<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# CoForge repository instructions

These instructions apply to the entire repository.

## Decisions

- Do not turn an unresolved question into code or a repository convention. Present the options and trade-offs in `#coforge`, then record the decision in the CR description before implementation; use Frank's approval only when the decision meets a gate below.
- This repository keeps no ADRs, no separate architecture document, and no implementation-slice notes. Do not create `docs/adr/`, `docs/architecture.md`, or similar decision logs, even when a skill suggests one. The architecture invariants below and the owning directory's `AGENTS.md` are the maintained rules.

## Documentation and agent instructions

- Put project documentation under `docs/`. The root `README.md` is the documentation index: every document or topic directory under `docs/`, each app or package `AGENTS.md`, and every package or directory `README.md` is linked from it with one line saying what it covers. Nested `AGENTS.md` files are linked from their parent `AGENTS.md`.
- Use progressive disclosure. A document is an overview plus links to smaller topic files; keep each Markdown file under 200 lines and split it into a directory of topic files before it grows past that.
- Keep each `AGENTS.md` under 200 lines. It holds rules an agent cannot infer from the code: commands, conventions, boundaries, and gotchas. Do not write function-by-function descriptions, implementation walkthroughs, change history, or "historical status" notes; the code, its comments, and its tests carry those.
- Place instructions next to the code they govern. A rule that applies only to one directory belongs in that directory's `AGENTS.md`, which agents load only when they work there. Put long, occasionally needed procedures in a skill under `.agents/skills/` with its details in linked reference files.
- A change that alters documented behavior, a rule, or a command updates the document that states it in the same CR. Delete statements that are no longer true instead of annotating them.

## Module design and implementation discipline

- Treat `coforge-computer` and `coforge-daemon` as large, long-lived products.
  Before adding a feature, identify its owning module and its public seam; do
  not put new business logic in the nearest command, entrypoint, or transport
  file merely because it is convenient.
- Keep CLI commands thin. A command may parse arguments, invoke an
  application use case, and format the result for a human. Workspace lookup,
  authentication, registration, runtime discovery, persistence, process
  supervision, and protocol encoding belong to reusable modules below the
  command layer.
- Keep the abstraction gradient explicit: upper layers express business
  intent (`setupComputer`, `registerComputer`, `startDaemonRuntime`); middle
  layers coordinate domain operations (`getBySlug`, `buildRegistration`,
  `ensureStarted`); lower layers expose implementation details (`encode`,
  `writeFrame`, `spawn`, `flush`). Do not create cross-layer methods such as
  `findWorkspaceAndRegisterComputer` or
  `setupAndSendProtobufOverSocket`.
- Dependencies point downward. Entry points and commands may depend on
  application/domain modules; domain modules may depend on ports/contracts;
  infrastructure modules implement those ports. Domain code must not import
  Commander, terminal UI, filesystem paths, sockets, database clients, or
  provider-specific agent parsers.
- Name modules after stable domain concepts and one responsibility. Prefer
  names such as `WorkspaceCatalog`, `WorkspacePicker`, `ComputerRegistrar`,
  `RuntimeInventory`, `MachineIdentity`, `CredentialStore`, and
  `AgentRuntimePool`. Avoid vague names such as `Helper`, `Utils`,
  `Service`, `Resolver`, or `Manager` unless the name is an established
  domain role with a narrowly defined responsibility.
- Import code in the same package through the `#src/` alias
  (`#src/code-agent/contract`), and a sibling file through `./`. Do not write
  `../` into the package's own `src/`. Packages declare `#src/*` in their
  `package.json` `imports` (Node subpath imports, so each package resolves its
  own alias even when another package compiles its source); `apps/web` declares
  it only in `tsconfig.json` because it has `.tsx` modules, never as a per-file
  `package.json` `imports` map. Web's type check applies that mapping to package source it
  compiles, so a package `#src/x` must never name a file that also exists in
  `apps/web/src` (`apps/web/test/import-alias-isolation.test.ts` enforces it).
  Another package is imported by its package name (a `workspace:*`
  dependency, then the entry or a subpath). The repository-root `scripts/`
  belong to no package, so `apps/*` and `packages/*` import them by relative
  path. Scripts that run before `bun install` (staging `deploy` runs
  `validate-web-push-keys.ts`) keep relative imports: package names need it.
- Keep terminology consistent across code, protocol, logs, and documentation.
  Use one convention for each concept; do not alternate between snake_case,
  camelCase, and arbitrary synonyms for the same public field or event.
- Use the repository's logging framework directly. Configure its sinks and
  lifecycle once at the application entry point, and obtain category loggers
  through the framework in owning modules. Do not add a logger wrapper,
  adapter, facade, parallel low-level logger, or another abstraction layer over
  capabilities the logging framework already provides.
- Keep a module map in the owning app's `AGENTS.md`: one line per module
  naming its directory and single responsibility. Update it before
  reorganizing or adding a module. If the ownership or boundary is unclear,
  stop and settle the design options before writing implementation code.
- For behavior changes, establish the public module seam and regression test
  first. Test application/domain behavior independently from CLI rendering,
  transport framing, and provider-specific adapters.

## Decision gates

- Obtain Frank's explicit approval before changing architecture, database schema, wire protocol, licensing, security boundaries, or another decision with broad or difficult-to-reverse impact. Ordinary reversible implementation choices use the MVP fast lane below.
- Prefer a mature maintained framework when it satisfies the requirements. Propose custom infrastructure only after documenting the gap, maintenance burden, and alternatives.
- Base technical proposals and implementations on current official documentation, official repositories, and official migration guides. Do not rely on remembered or built-in knowledge for versions, APIs, configuration, or support status.
- For each broad or difficult-to-reverse technical proposal, cite its official sources and state the problem, candidates, maturity, license, runtime compatibility, operational cost, migration/rollback impact, recommendation, and unresolved risks. Mark experimental or undocumented behavior explicitly.
- Do not add or change a repository license without Frank's explicit approval.
- Establish formatting and lint checks before feature implementation, and make them required CR checks once adopted.
- Do not add or broaden lint, formatting, type-check, or test exemptions without
  the user's explicit prior approval, including exemptions for official upstream
  components. This covers configuration overrides, ignore patterns, inline
  disable comments, and skipped checks. Fix the underlying code instead; an
  existing exemption is not permission to add another. When requesting approval,
  name the exact files, rules, reason, and verification being bypassed.

## Collaboration and delivery

- Follow the lightweight, branch-based [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow) for every change that goes through a CR: create it on a short-lived feature branch from the latest `origin/main` with a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`, keep it to one small objective, and as a rule merge or close it within the same working day. Prefer a sequence of small CRs to a multi-day feature branch. Do not use a long-lived `dev` branch.
- A maintainer (the Maintain or Admin repository role) may push directly to `main` after running the relevant local checks (`mise run test`, `mise run check`, `mise run build`). CI validates every push to `main` on GitHub only afterwards: it blocks nothing, so the local checks still come first, and a red run on `main` is fixed before anything else is pushed. An Agent working in this repository commits under the identity rule below and pushes directly to `main` the same way, after the local checks, `simplify` and an independent code review; it does not open a PR. Everyone else, and any change that needs review, reaches `main` through a CR/PR with the required "CI passed" check; no approval is required. Nobody may delete `main`.
- Use the MVP fast lane for ordinary implementation and documentation: the short automated checks, and immediate squash/rebase merge once feedback is resolved. Target a 5–10 minute CR-to-merge cycle; Frank does not need to approve each ordinary CR, but his explicit approval remains required for the decision gates above and for changes to architecture, database schema, wire protocol, licensing, security boundaries, or other decisions with broad or difficult-to-reverse impact.
- Before requesting final review, fetch and rebase the branch onto the latest `origin/main`. Amend or rebase mistakes on the feature branch before review; do not add revert commits merely to clean up work that has not been merged. Rewrite or force-push `main` only when Frank explicitly asks, and never force-push another contributor's branch. Keep `main` history clean and linear: merge a CR with the repository's approved squash/rebase strategy and then delete the merged branch, and push directly to `main` only commits that fast-forward it; do not create gratuitous merge commits.
- Read code where it is committed — `git show origin/main:<path>`, or a fresh worktree created at `origin/main` — rather than from a long-lived checkout. Such a tree can be days behind, and everything read from it answers for the code of that day: against one, a search reported a mechanism as absent from the repository and a function looked like an untransformed second copy, when in both cases the commit that had changed it was already on `main`. Two agents reached those two conclusions from the same stale checkout within a day of each other.
- Use concise English Conventional Commit messages: `<type>(optional-scope): imperative summary` (for example, `docs: refine delivery guarantees`). Commit as the person running the Agent, in their own GitHub identity; never as another person, an Agent name or an Agent email.
- Keep each branch and CR to one concern. Preserve unrelated work and coordinate in `#coforge` before touching files another contributor has claimed. Coordinate before changing a shared contract. Claim a task before changing files, then read the board row back: `coforge task list --target '#coforge'` must show the task pointing at you. A claim that reports success is not evidence — the row is; on 2026-09-28 two agents built the same change under separate cards after a claim seemed to succeed while the row named the other holder, and the second CR was withdrawn.
- A CR must describe its scope, approved decisions, official source links for technical choices, tests and checks run, known risks, and any follow-up work. Do not merge while review comments remain unresolved. A direct push has no CR, so the commit is the unit of work and its message body carries the same record, plus the Agent session that produced it (its id or link) when there is one.
- During MVP, keep required CI short: formatting/linting, type checking, relevant tests, and build. Add slower checks only when their risk reduction justifies the feedback delay. GitHub documents reviews and status checks as independently configurable [branch protection options](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- A task is complete only after the relevant short checks pass and the change is on `main`, merged through its CR or pushed directly by a maintainer. If a check does not exist yet, state that clearly in the CR or the direct push's commit message.
- Develop behavioral changes with test-driven development. Agree the public test seam first, then work in vertical slices: one failing test followed by the minimum implementation that passes it. Start bug fixes with a regression test. Do not remove or weaken a valid test merely to make CI pass.
- Removing an export or mechanism means removing all of it: the implementation, its tests, and every assertion that pins it — grep all three. A CI-green run that leaves a pinned assertion behind is not a pass; #1081's first run failed on exactly that.
- Keep refactoring in the independent review stage rather than expanding a red-green implementation slice. Once the slice is green, run the `simplify` skill (built into Claude Code) on the branch diff, re-run the relevant checks, then request an independent code review.

## Testing

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- When writing or modifying tests, investigating test failures, or reviewing test changes, read and follow [the testing guidance](docs/agents/testing.md). Unrelated tasks do not require loading this document.
- Inside a CoForge Agent, start every test run through the isolation wrapper `scripts/test/isolated-test-run.ts`, which runs it without the Agent's and the Workspace's CoForge credentials and identity. The mise `test` tasks (`mise run test`, `test:*`, `mise run test:file -- <path> [flags]` from the package directory) and the root `test:*` scripts already do; run any other test command or script (`scripts/e2e/*.sh`, say) as `bun scripts/test/isolated-test-run.ts <command>`.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Run `mise run test`, `mise run check`, and `mise run build` before submitting a change; CI runs them in that order.
- Reach the formatter through `mise run check` or the workspace's own script; never invoke a formatter binary directly. A default-config run does not read this repository's settings and rewrites files nobody touched — one `oxfmt` run over a directory reformatted 49 unrelated files, including a generated route tree.
- Before adding, changing, or removing a mise task, read and follow
  [the mise task policy](docs/agents/mise-tasks.md).
- Keep mise as the small, stable repository command surface: add a task only
  for a documented developer entry point, reusable repository gate,
  cross-workspace or cross-tool orchestration, or behavior that needs mise task
  features. Keep package-owned commands in that workspace's `package.json`;
  never mirror every package script or add a CI-only forwarding task.
- Give each operation one implementation owner. Keep short task declarations
  in `mise.toml`, substantial procedural logic in checked executable scripts,
  and CI-provider concerns in workflow YAML.

- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, and CI together.
- Protobuf schemas under `packages/coforge-sdk/proto` must pass `buf lint` and
  `buf format --diff --exit-code`; do not use TypeScript lint rules as a
  substitute for `.proto` validation.
- Never edit any `package.json` manually with an editor or patch. Use Bun's
  package-management commands instead: `bun add`, `bun remove`,
  `bun pm pkg set`, or `bun pm pkg delete`. Run the command from the owning
  workspace, then review the resulting manifest and `bun.lock` diff. A
  dependency change is incomplete unless the lockfile is updated and the
  relevant check passes.
- Do not hand-edit `bun.lock`; regenerate it through Bun after changing a
  package manifest.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start with Bun 1.4 as the business-control runtime.
- Bun-specific runtime and compatibility guidance lives in
  `.agents/skills/using-bun-runtime/SKILL.md`; load it before changing Bun
  runtime code or dependencies. The target runtime remains Bun, never Node (the installer crate is Rust).

## Shared agent skills

- Read [the shared agent skills rules](docs/agents/shared-agent-skills.md) before using a project skill, reviewing a change, releasing, or researching the reference Computer.

## Architecture invariants

These bind every change. Read [the architecture invariants](docs/agents/architecture-invariants.md) before touching a package boundary, the protocol, the realtime transport, or stored data.

## Dependency and security rules

- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Launch Agent processes in their declared Agent workspace directories. Inherit the Daemon's ordinary local environment, then apply explicit Agent overrides, adapter extraEnv, and trusted CoForge launch fields. Never upload inherited environment variables; cloud persistence is only for user-entered overrides. Clear stale CoForge Agent capabilities, control sockets, and the Workspace Daemon's own scope variables (its state directory, launchd job scope, supervisor channel, and cloud endpoint) before installing the current launch fields.
