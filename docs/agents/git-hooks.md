# Git hooks

The repository's git hooks live in `.githooks/`. `bun install` runs the root package's
`prepare` script, which runs `scripts/git-hooks/install-hooks-path.ts`. That script sets the
repository-local `core.hooksPath` to `.githooks`. Git resolves a relative hooks path from the
directory hooks run in, which is the root of the work tree, so the one setting serves every
worktree. The installer does nothing outside a git work tree (a Docker build context, an unpacked
tarball). It leaves an existing `core.hooksPath` of yours alone and prints one line instead; point
that hooks directory at `.githooks/pre-commit` yourself if you want the check. A CoForge Agent's
own hook shims forward to the repository's hooks directory, so Agents run these hooks too.

In a fresh clone or worktree, no hook runs until the first `bun install`, and
`bun install --ignore-scripts` skips `prepare`, so it leaves the hook off. `.gitattributes` keeps
`.githooks/*` at `text eol=lf`, so a `core.autocrlf=true` checkout (Git for Windows) does not give
the `#!/bin/sh` hook CRLF line endings.

The repository uses plain `core.hooksPath` rather than a hook manager. husky sets
`core.hooksPath` without checking for an existing value, which must be left alone. lefthook adds a
dependency whose postinstall Bun does not run unless the package is trusted. Either way the
ratchet itself would still be custom code.

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

When the hook blocks a commit, it exits non-zero, so git aborts the commit. It lists each file
with its size in tokens and why: a new file, or the HEAD and staged sizes in bytes for one that
crossed the limit or grew. Split the file into smaller ones.

### Files that are not checked

- **Generated files.** A file whose `linguist-generated` attribute is set in the staged root
  `.gitattributes` is skipped: lockfiles, generated code, and benchmark or evaluation data. On
  GitHub the same attribute also excludes the file from language statistics and suppresses it in
  diffs. Mark a file only if a tool genuinely produces it, never to get an agent-written file past
  the limit. Translation files under `apps/web/messages/` are agent-written and stay checked.
  `git check-attr --cached linguist-generated -- <path>` shows the staged value.
- **Binary files.** A file with a NUL byte in its first 8,000 bytes, the test git's own
  `buffer_is_binary` applies.

### What is not covered

- `git commit --no-verify` skips the hook for one commit. CI does not run this check, so the hook
  is the only enforcement.
- Merge commits that `git merge` creates by itself: it runs `pre-merge-commit`, which this
  repository does not provide. A merge that stops on conflicts is committed separately, and that
  commit runs `pre-commit`, so it is checked.
- `git am` runs `pre-applypatch`, which this repository does not provide.
- Commits that `git cherry-pick`, `git rebase` and `git revert` create themselves did not run
  `pre-commit` when this was tested with git 2.54 (githooks documents `pre-commit` for
  `git commit` only). A step that stopped on conflicts and was concluded with `git commit` or
  `--continue` did run it.
- `git commit --amend` compares against the commit being amended, so a file that commit added
  without the hook counts as existing.

The hook runs the check with `bun` from PATH, or mise's pinned `bun`. When it finds neither, it
blocks the commit and says so.

## Sources

- git hooks: [githooks](https://git-scm.com/docs/githooks) (`pre-commit`, `pre-merge-commit`,
  `pre-applypatch`, and the directory hooks run in).
- [`core.hooksPath`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
  in git-config.
- [gitattributes](https://git-scm.com/docs/gitattributes) (`text`, `eol`, pattern matching) and
  [git-check-attr](https://git-scm.com/docs/git-check-attr).
- [Linguist overrides](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md)
  (`linguist-generated`).
- [`bun install`](https://bun.com/docs/pm/cli/install) (the project's lifecycle scripts,
  `--ignore-scripts`, and trusted dependencies).
- git's binary test: `buffer_is_binary` in
  [xdiff-interface.c](https://github.com/git/git/blob/master/xdiff-interface.c).
- husky's install step: [index.js](https://github.com/typicode/husky/blob/main/index.js).
