# Collaboration and delivery

Part of [the documentation index](../../README.md). The root [AGENTS.md](../../AGENTS.md) keeps the
rules; this page holds the details and the incidents behind them.

## GitHub Flow and direct pushes

Follow the lightweight, branch-based [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)
for every change that goes through a CR: create it on a short-lived feature branch from the latest
`origin/main` with a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`, keep it to one small
objective, and as a rule merge or close it within the same working day. Prefer a sequence of small CRs
to a multi-day feature branch. Do not use a long-lived `dev` branch.

A maintainer (the Maintain or Admin repository role) may push directly to `main` after running the
relevant local checks (`mise run test`, `mise run check`, `mise run build`). CI validates every push to
`main` on GitHub only afterwards: it blocks nothing, so the local checks still come first, and a red run
on `main` is fixed before anything else is pushed. An Agent working in this repository commits under the
identity rule below and pushes directly to `main` the same way, after the local checks, `simplify` and
an independent code review (which covers performance, below); it does not open a PR. Everyone else, and
any change that needs review, reaches `main` through a CR/PR with the required "CI passed" check; no
approval is required. Nobody may delete `main`.

Use the MVP fast lane for ordinary implementation and documentation: the short automated checks, and
immediate squash/rebase merge once feedback is resolved. Target a 5–10 minute CR-to-merge cycle; Frank
does not need to approve each ordinary CR, but his explicit approval remains required for the decision
gates in the root `AGENTS.md` and for changes to architecture, database schema, wire protocol,
licensing, security boundaries, or other decisions with broad or difficult-to-reverse impact.

Before requesting final review, fetch and rebase the branch onto the latest `origin/main`. Amend or
rebase mistakes on the feature branch before review; do not add revert commits merely to clean up work
that has not been merged. Rewrite or force-push `main` only when Frank explicitly asks, and never
force-push another contributor's branch. Keep `main` history clean and linear: merge a CR with the
repository's approved squash/rebase strategy and then delete the merged branch, and push directly to
`main` only commits that fast-forward it; do not create gratuitous merge commits.

## Read the committed code

Read code where it is committed — `git show origin/main:<path>`, or a fresh worktree created at
`origin/main` — rather than from a long-lived checkout. Such a tree can be days behind, and everything
read from it answers for the code of that day: against one, a search reported a mechanism as absent
from the repository and a function looked like an untransformed second copy, when in both cases the
commit that had changed it was already on `main`. Two agents reached those two conclusions from the
same stale checkout within a day of each other.

## Remove the worktree once the change is on main

A worktree is one change's temporary checkout. Once the change is on `main`, remove it with
`git worktree remove <path>`; do not keep it for a next time. Dependencies come from Bun's shared
cache, so what each one holds is its own build output and generated code, and a tree left behind
answers for an older `main`. On 2026-11-02 the main repository registered 113 worktrees, most of
them for changes already on `main`; removing 64 of them freed about 20 GB.

`mise run cleanup` lists the worktrees whose change is already on `main` and the `bun`/`node`
processes left in a directory that no longer exists, such as a forwarder holding ports 5432 and
6379. `mise run cleanup -- --apply` stops those processes, removes those worktrees and deletes the
branches whose tip is already in `main` or whose own commits are all on it (never `main`, `master` or the remote's default). A
worktree is removed only when it is clean, every commit on it has a patch-equivalent on
`origin/main` (a squash of several commits is not detected), it holds no merge commit and, when
detached, no commit only its reflog keeps. It must also have been quiet for an hour, and for a day
(`--idle-hours`) when it never committed, so a worktree another session just created stays. No
process of yours may run inside it. Removing a worktree deletes its ignored files too (`.env`,
copied `infra/secrets`, local data). macOS and Linux find the processes inside a worktree
(`lsof`, `/proc`) and the orphans left in a removed one; Windows cannot, so it moves each worktree aside and back right before removing it
(Windows refuses while a process uses it), keeps one it cannot move, and has no orphan cleanup. On
another platform, or when the scan fails, `--apply` removes no worktree.

## Commit messages

Use concise English Conventional Commit messages: `<type>(optional-scope): imperative summary` (for
example, `docs: refine delivery guarantees`). Commit as the person running the Agent, in their own
GitHub identity; never as another person, an Agent name or an Agent email.

## Claim the task

Keep each branch and CR to one concern. Preserve unrelated work and coordinate in `#coforge` before
touching files another contributor has claimed. Coordinate before changing a shared contract. Claim a
task before changing files, then read the board row back: `coforge task list --target '#coforge'` must
show the task pointing at you. A claim that reports success is not evidence — the row is; on 2026-09-28
two agents built the same change under separate cards after a claim seemed to succeed while the row
named the other holder, and the second CR was withdrawn.

## CR contents and CI

A CR must describe its scope, approved decisions, official source links for technical choices, tests
and checks run, known risks, and any follow-up work. Do not merge while review comments remain
unresolved. A direct push has no CR, so the commit is the unit of work and its message body carries the
same record, plus the Agent session that produced it (its id or link) when there is one.

During MVP, keep required CI short: formatting/linting, type checking, relevant tests, and build. Add
slower checks only when their risk reduction justifies the feedback delay. GitHub documents reviews and
status checks as independently configurable
[branch protection options](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

A task is complete only after the relevant short checks pass and the change is on `main`, merged
through its CR or pushed directly by a maintainer. If a check does not exist yet, state that clearly in
the CR or the direct push's commit message.

## TDD and removal

Develop behavioral changes with test-driven development. Agree the public test seam first, then work in
vertical slices: one failing test followed by the minimum implementation that passes it. Start bug
fixes with a regression test. Do not remove or weaken a valid test merely to make CI pass.

Removing an export or mechanism means removing all of it: the implementation, its tests, and every
assertion that pins it — grep all three. A CI-green run that leaves a pinned assertion behind is not a
pass; #1081's first run failed on exactly that.

## Review

Keep refactoring in the independent review stage rather than expanding a red-green implementation
slice. Once the slice is green, run the `simplify` skill (built into Claude Code) on the branch diff,
re-run the relevant checks, then request an independent code review.

The independent review includes a performance pass over the same diff: read the changed code, plus the
files the area checklist's "Read first" names, against the
[perf-scan](../../.agents/skills/perf-scan/SKILL.md) checklist for that area (`web-server`, `daemon`,
`web-client`, else `generic`). Fix before pushing a new N+1 on a hot path, an unbounded `findMany` or
over-fetch, work inside a lock or transaction that belongs outside it, and serial awaits that could run
in parallel; every other finding goes in the task thread and does not block the push.
