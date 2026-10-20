# Limits

Part of [Git hooks](README.md): what the [hooks](README.md), the `mise run check` gate and the
[hard rules](hard-rules.md) in CI do not catch.

- The hooks are local: `git commit --no-verify` and `git push --no-verify` skip them, and a clone
  or worktree has none until `bun install`. `mise run check` (`bun run check`), which root
  `AGENTS.md` requires before every push, starts with `scripts/ci/local-gate.ts`. It fails when
  `core.hooksPath` is unset, and only warns when it names your own hooks directory: the
  repository's pre-commit and pre-push then do not run unless your hooks call them, but the gate
  still range-checks the commits not yet on your local `origin/main`, so a violation is reported
  before a push that follows the check. Without `origin` or `origin/main` it says so and skips
  that part; a stale `origin/main` can list others' commits, so a failure names its base and asks
  for `git fetch origin`. It changes no config, and does nothing with `CI=true` or outside a work
  tree. It is a convention, and `--no-verify` bypasses the hooks: only CI cannot be skipped.
- A maintainer or an Agent may push directly to `main` (root `AGENTS.md`); CI validates a push only
  afterwards, so a violation that got past the hook and the gate is reported once on `main`, and
  its author fixes it before pushing anything else. A PR cannot merge without "CI passed".
- Merges, rebases (`--continue` included), reverts, `git am` and a conflict-free cherry-pick do
  not run `pre-commit` ([details](size-limit.md#what-is-not-covered)).
- A CI run without a base commit only warns, so that range is never checked.
- A push run cancelled by a newer push loses its identity check: the newer push's `before` is the
  cancelled push's head. The file rules still cover it, as the next run diffs from the last pass.
- A violation in CI fails the Plan checks job, so the checks it would have selected are skipped
  until the violation is fixed.
- The exemption lists, `skills-lock.json` and `.gitattributes`, are read from the change's base,
  so a change cannot exempt itself: in CI the merge base; in pre-commit HEAD's merge base with
  `origin/main`, else with its upstream, else HEAD (nothing before the first commit). With neither
  (no remote, or one not named `origin`), an `--amend` or a local list commit can exempt files from
  the hook until CI checks them. Exempting new files takes two steps: commit and push the list
  change and let its CI run pass, then commit the files; both in one push or PR is a red CI run.
- A line inside a template string that starts with a suppression directive is flagged.
