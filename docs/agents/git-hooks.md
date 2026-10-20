# Git hooks

The repository's git hooks live in `.githooks/`. `bun install` enables them: the root
`prepare` script runs `scripts/git-hooks/install-hooks-path.ts`, which sets the repository-local
`core.hooksPath` to `.githooks`. It does nothing outside a git work tree (a Docker build context,
an unpacked tarball), and it leaves an existing `core.hooksPath` of yours alone, printing one line
instead; point that hooks directory at `.githooks/pre-commit` yourself if you want the check. A
CoForge Agent's own hook shims forward to the repository's hooks directory, so Agents run these
hooks too. In a fresh clone or worktree, no hook runs until the first `bun install`.

The repository uses plain `core.hooksPath` rather than a hook manager. husky's `prepare`
overwrites an existing `core.hooksPath`, which must be left alone. lefthook adds a dependency
whose postinstall Bun blocks unless it is trusted. Either way the ratchet itself would still be
custom code.

## Pre-commit: file size limit

A commit may not add agent-written files over **5,000 tokens**, estimated as bytes / 4: the limit
is 20,000 bytes, so a file of exactly 20,000 bytes is allowed and one of 20,001 is not. The check
(`scripts/git-hooks/staged-file-size.ts`) reads the staged blobs, the content being committed,
never the working tree, and judges each added, modified, renamed or type-changed file:

| Staged file over the limit | Result |
| --- | --- |
| New: no HEAD version (a copy counts as new) | Blocked |
| Existing file that was within the limit at HEAD | Blocked: it crossed the limit |
| Existing file already over the limit at HEAD, staged at or below its HEAD size | Allowed |
| Existing file already over the limit at HEAD, staged larger than its HEAD size | Blocked: it grew |

This is a ratchet: files that were already over the limit when the hook arrived may shrink or
stay the same, but never grow. A rename is judged against the size its source path had at HEAD.
Deletions and submodules are not checked.

When the hook blocks a commit it lists each file with its size in tokens and why: a new file,
or the HEAD and staged sizes in bytes for one that crossed the limit or grew. Split the file into
smaller ones.

### Files that are not checked

There are two exemption mechanisms, both read from the staged root `.gitattributes`.
`git check-attr linguist-generated size-limit -- <path>` shows a path's values.

- **Generated files: `linguist-generated`.** A file whose `linguist-generated` attribute is set
  is skipped: lockfiles, generated code, and benchmark or evaluation data. GitHub also collapses
  these files in diffs. Use it only for a file a tool genuinely produces, never to get an
  agent-written file past the limit. Translation files under `apps/web/messages/` are
  agent-written and stay checked.
- **Agent-written but structurally unsplittable: `size-limit=off`.** A file whose `size-limit`
  attribute is exactly `off` is skipped; any other value, or none, leaves it checked. Unlike
  `linguist-generated` it changes nothing else, so the file's diffs stay visible. Use it
  sparingly, for a file that cannot be split at all (today only `apps/web/package.json`, whose
  hand-maintained `imports` map has one entry per module alias), and give the reason in the
  commit that adds the pattern, plus a one-line comment above it.
- **Binary files.** A file with a NUL byte in its first 8,000 bytes (git's own heuristic).

### What is not covered

- `git commit --no-verify` skips the hook for one commit. CI does not run this check, so the hook
  is the only enforcement.
- Merge commits: `git merge` runs `pre-merge-commit`, which this repository does not provide.
- Commits that `git cherry-pick`, `git rebase` and `git revert` create themselves run no
  pre-commit hook.
- In both cases, a merge or step that stops on conflicts and is concluded with `git commit` or
  `--continue` is checked.
- `git commit --amend` compares against the commit being amended, so a file that commit added
  without the hook counts as existing.

The hook runs the check with `bun` from PATH, or mise's pinned `bun`. When it finds neither, it
blocks the commit and says so.
