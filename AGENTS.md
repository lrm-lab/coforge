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

Read [module design](docs/agents/module-design.md) when adding a feature or module, writing imports, naming, logging, or keeping the module map.
- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.

## Decision gates

- Obtain Frank's explicit approval before changing architecture, database schema, wire protocol, licensing, security boundaries, or another decision with broad or difficult-to-reverse impact. Ordinary reversible implementation choices use the MVP fast lane below.
- Read [proposals](docs/agents/proposals.md) when proposing a framework, custom infrastructure, or a broad or difficult-to-reverse technical change.
- Do not add or change a repository license without Frank's explicit approval.
- Establish formatting and lint checks before feature implementation, and make them required CR checks once adopted.
- Do not add or broaden lint, formatting, type-check, or test exemptions without the user's explicit prior approval, including exemptions for official upstream components. This covers configuration overrides, ignore patterns, inline disable comments, and skipped checks. Fix the underlying code instead; an existing exemption is not permission to add another. When requesting approval, name the exact files, rules, reason, and verification being bypassed.

## Collaboration and delivery

Details and the incidents behind these rules are in [delivery](docs/agents/delivery.md).

- Follow branch-based GitHub Flow; a maintainer or an Agent may push directly to `main` after the local checks, `simplify` and an independent review; everyone else reaches `main` through a CR.
- Use the MVP fast lane ([defined in delivery](docs/agents/delivery.md)) for ordinary changes; the decision gates still need Frank.
- Rebase before review; never force-push another contributor's branch; keep `main` linear.
- Read code from `origin/main` or a fresh worktree, never a long-lived checkout.
- Remove the worktree you created for a change once that change is on `main` (`git worktree remove <path>`); do not keep it for a next time.
- Use concise English Conventional Commit messages, as the person running the Agent; never an Agent or bot identity.
- Keep one concern per branch; claim a task and read the board row back before changing files.
- A CR or direct-push commit message records scope, decisions, sources, checks, risks, follow-ups and the Agent session, and ends with a `Revert-effect:` trailer naming what reverting it would break (`none` for docs and tests). Read [the commit message rules](docs/agents/git-hooks/hard-rules.md) when splitting commits or touching a high-risk path ([the list](scripts/ci/high-risk-paths.txt)).
- Keep required CI short; a task is complete only after the checks pass and the change is on `main`.
- Develop with TDD: a failing test first, the minimum implementation, no weakened tests.
- Remove an export or mechanism completely: implementation, tests and every assertion that pins it.
- Run `simplify` and an independent review (including the performance pass) before pushing.

## Testing

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- Do not write UI unit tests; verify UI changes by hand as [the UI verification policy](docs/agents/testing.md#ui-verification-policy) describes.
- When writing or modifying tests, investigating test failures, or reviewing test changes, read and follow [the testing guidance](docs/agents/testing.md). Unrelated tasks do not require loading this document.
- Inside a CoForge Agent, start every test run through the isolation wrapper `scripts/test/isolated-test-run.ts`, which runs it without the Agent's and the Workspace's CoForge credentials and identity. The mise `test` tasks (`mise run test`, `test:*`, `mise run test:file -- <path> [flags]` from the package directory) and the root `test:*` scripts already do; run any other test command or script (`scripts/e2e/*.sh`, say) as `bun scripts/test/isolated-test-run.ts <command>`.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Run `mise run test`, `mise run check`, and `mise run build` before submitting a change; CI runs them in that order.
- Reach the formatter through `mise run check` or the workspace's own script; never invoke a formatter binary directly. A default-config run does not read this repository's settings and rewrites files nobody touched — one `oxfmt` run over a directory reformatted 49 unrelated files, including a generated route tree.
- Before adding, changing, or removing a mise task, read and follow [the mise task policy](docs/agents/mise-tasks.md).
- Read [the mise task policy](docs/agents/mise-tasks.md#command-surface) when deciding whether a command belongs in mise or a package.
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, and CI together.
- Read [the SDK rules](packages/coforge-sdk/AGENTS.md) when changing `.proto` files.
- Never edit any `package.json` manually with an editor or patch. Use Bun's package-management commands instead: `bun add`, `bun remove`, `bun pm pkg set`, or `bun pm pkg delete`. Run the command from the owning workspace, then review the resulting manifest and `bun.lock` diff. A dependency change is incomplete unless the lockfile is updated and the relevant check passes.
- Do not hand-edit `bun.lock`; regenerate it through Bun after changing a package manifest.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start with Bun 1.4 as the business-control runtime.
- Bun-specific runtime and compatibility guidance lives in `.agents/skills/using-bun-runtime/SKILL.md`; load it before changing Bun runtime code or dependencies. The target runtime remains Bun, never Node (the installer crate is Rust).

## Shared agent skills

- Read [the shared agent skills rules](docs/agents/shared-agent-skills.md) before using a project skill, reviewing a change, releasing, or researching the reference Computer.

## Architecture invariants

These bind every change. Read [the architecture invariants](docs/agents/architecture-invariants.md) before touching a package boundary, the protocol, the realtime transport, or stored data.

## Dependency and security rules

- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Launch Agent processes in their declared Agent workspace directories. Never upload inherited environment variables; cloud persistence is only for user-entered overrides. Read [the daemon rules](packages/daemon/AGENTS.md#agent-process-environment) when changing how Agent processes are launched.
