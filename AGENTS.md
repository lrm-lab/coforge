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
- This repository keeps no ADRs, no separate architecture document, and no implementation-slice notes. Do not create decision logs, even when a skill suggests one (`no-decision-docs` blocks `docs/adr/` and `docs/architecture.md`). The architecture invariants below and the owning directory's `AGENTS.md` are the maintained rules.
- This repository keeps no `docs/research/` directory and no research or audit note files (`no-research-docs` blocks any tracked file under `docs/research/`). Record findings in the task thread, CR description, or scratch artifacts instead of committing them to the repository.

## Documentation and agent instructions

- Put project documentation under `docs/`. The root `README.md` is the documentation index: every document or topic directory under `docs/`, each app or package `AGENTS.md`, and every package or directory `README.md` is linked from it with one line saying what it covers. A nested `AGENTS.md` is linked from the README or an ancestor `AGENTS.md`; `docs-index` checks the `docs/` entries and the `AGENTS.md` links.
- Use progressive disclosure: a document is an overview plus links to smaller topic files, split into a directory before it grows (`markdown-lines` and `markdown-links` enforce the 200-line limit and valid links).
- An `AGENTS.md` holds rules an agent cannot infer from the code: commands, conventions, boundaries, and gotchas. Do not write function-by-function descriptions, implementation walkthroughs, change history, or "historical status" notes; the code and its tests carry those.
- Place instructions next to the code they govern. A rule that applies only to one directory belongs in that directory's `AGENTS.md`, which agents load only when they work there. Put long, occasionally needed procedures in a skill under `.agents/skills/` with its details in linked reference files.
- A change that alters documented behavior, a rule, or a command updates the document that states it in the same CR. Delete statements that are no longer true instead of annotating them.

## Module design and implementation discipline

Read [module design](docs/agents/module-design.md) when adding a feature or module, writing imports, naming, logging, or keeping the module map.
- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Good code explains itself: write no code comments, and carry intent in names, types and tests. When you work in a file, delete every comment it can do without; keep only tool directives such as approved suppressions and pragmas.

## Decision gates

- Obtain Frank's explicit approval before changing architecture, database schema, wire protocol, licensing, security boundaries, or another decision with broad or difficult-to-reverse impact. Ordinary reversible implementation choices use the MVP fast lane below.
- Read [proposals](docs/agents/proposals.md) when proposing a framework, custom infrastructure, or a broad or difficult-to-reverse technical change.
- Do not add or change a repository license without Frank's explicit approval.
- Do not add or broaden lint, formatting, type-check, or test exemptions without the user's explicit prior approval, including exemptions for official upstream components. `new-suppression` blocks the inline ones at commit and the edit hook asks before a config file changes. Fix the underlying code instead; an existing exemption is not permission to add another. When requesting approval, name the exact files, rules, reason, and verification being bypassed.

## Collaboration and delivery

Details and the incidents behind these rules are in [delivery](docs/agents/delivery.md).

- Follow branch-based GitHub Flow; a maintainer or an Agent may push directly to `main` after the local checks, `simplify` and an independent review; everyone else reaches `main` through a CR.
- Use the MVP fast lane ([defined in delivery](docs/agents/delivery.md)) for ordinary changes; the decision gates still need Frank.
- Rebase before review; never force-push another contributor's branch; keep `main` linear.
- Read code from `origin/main` or a fresh worktree, never a long-lived checkout.
- Remove the worktree you created for a change once that change is on `main` (`git worktree remove <path>`); do not keep it for a next time.
- Use concise English Conventional Commit messages, as the person running the Agent.
- Keep one concern per branch; claim a task and read the board row back before changing files.
- A CR or direct-push commit message records scope, decisions, sources, checks, risks, follow-ups and the Agent session. Read [the commit message rules](docs/agents/git-hooks/hard-rules.md) when splitting commits or touching a high-risk path ([the list](scripts/ci/high-risk-paths.txt)).
- Keep required CI short; a task is complete only after the checks pass and the change is on `main`.
- Remove an export or mechanism completely: implementation, tests and every assertion that pins it.
- Run `simplify` and an independent review (including the performance pass and official-docs pass) before pushing.

## Testing

- A behavior change starts with a failing test, then the minimum implementation; never weaken a test. Prefer E2E tests where they can verify the behavior, and end an E2E test with a verifiable, repeatable artifact. NO: tests written after the code to raise coverage, or UI unit tests. OK: a failing test first, E2E where possible, and UI changes verified by hand as [the UI verification policy](docs/agents/testing.md#ui-verification-policy) describes.
- When writing or modifying tests, investigating test failures, or reviewing test changes, read and follow [the testing guidance](docs/agents/testing.md). Unrelated tasks do not require loading this document.
- Inside a CoForge Agent, start every test run through the isolation wrapper `scripts/test/isolated-test-run.ts`, which runs it without the Agent's and the Workspace's CoForge credentials and identity. The mise `test` tasks (`mise run test`, `test:*`, `mise run test:file -- <path> [flags]` from the package directory) and the root `test:*` scripts already do; run any other test command or script (`scripts/e2e/*.sh`, say) as `bun scripts/test/isolated-test-run.ts <command>`.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Verify cheapest-first as [verify before pushing](docs/agents/delivery.md#verify-before-pushing) orders it: the local gate, the touched tests, then `mise run test`, `mise run check` and `mise run build` once; CI runs those three in that order. Stop after three failed fix rounds and bring the failure to Frank.
- Reach the formatter through `mise run check` or the workspace's own script; never type a formatter binary yourself (package scripts may call it; a Claude Code hook denies the typed call). A default-config run ignores this repository's settings and rewrites files nobody touched.
- Before adding, changing, or removing a mise task, or deciding whether a command belongs in mise or a package, read and follow [the mise task policy](docs/agents/mise-tasks.md) ([command surface](docs/agents/mise-tasks.md#command-surface)).
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, and CI together.
- Read [the SDK rules](packages/coforge-sdk/AGENTS.md) when changing `.proto` files.
- Change a `package.json` or `bun.lock` only through Bun's commands (`bun add`, `bun remove`, `bun pm pkg set`, `bun pm pkg delete`) run from the owning workspace, then review the manifest and `bun.lock` diff; a Claude Code hook denies a hand edit. A dependency change is incomplete unless the lockfile is updated and the relevant check passes.
- The accepted Web/backend direction is TanStack Start with Bun 1.4 as the business-control runtime; `no-nextjs` blocks a `next` dependency.
- Bun-specific runtime and compatibility guidance lives in `.agents/skills/using-bun-runtime/SKILL.md`; load it before changing Bun runtime code or dependencies. The target runtime remains Bun, never Node (the installer crate is Rust).

## Shared agent skills

- Read [the shared agent skills rules](docs/agents/shared-agent-skills.md) before using a project skill, reviewing a change, releasing, or researching the reference Computer.

## Architecture invariants

These bind every change. Read [the architecture invariants](docs/agents/architecture-invariants.md) before touching a package boundary, the protocol, the realtime transport, or stored data.

## Dependency and security rules

- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Launch Agent processes in their declared Agent workspace directories. Never upload inherited environment variables; cloud persistence is only for user-entered overrides. Read [the daemon rules](packages/daemon/AGENTS.md#agent-process-environment) when changing how Agent processes are launched.
