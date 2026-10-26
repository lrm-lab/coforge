# Pre-commit: file size limit

Part of [Git hooks](README.md).

A commit may not add agent-written files over **5,000 tokens**, estimated as bytes / 4: the limit
is 20,000 bytes, so a file of exactly 20,000 bytes is allowed and one of 20,001 is not. The check
(`scripts/git-hooks/staged-file-size.ts`, run by the hard-rules checker) reads the staged blobs,
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

A blocked commit lists each file with its size in tokens and why: a new file, or the HEAD and
staged sizes in bytes for one that crossed the limit or grew.

## Resolving a block

Restructure the file; do not trim it. Shorter names, deleted comments or denser code get a file
under the limit while leaving it as hard to work in as before. Find the file's natural seams (a
page section, a component, a hook, a group of functions with one job, a feature's messages) and
move each into a module of its own, as a refactor commit ahead of the change that grew the file.
That commit moves code verbatim, so it reviews as a move. A file already over the limit that
grew needs the same split, not a matching cut elsewhere in it.

## Files that are not checked

- **Generated files.** A file whose `linguist-generated` attribute is set in the base's root
  `.gitattributes` ([read from the base](limits.md)) is skipped: lockfiles and generated code. On
  GitHub the same attribute also excludes the file from language statistics and suppresses it in
  diffs. Mark a file only if a tool genuinely produces it, never to get an agent-written file past
  the limit. Translation files under `apps/web/messages/` are agent-written and stay checked.
  `git check-attr --source=<base> linguist-generated -- <path>` shows the value at a base.
- **Binary files.** A file with a NUL byte in its first 8,000 bytes, the test git's own
  `buffer_is_binary` applies.
- **Vendored skills.** Files under a skill directory registered in `skills-lock.json`, the
  [one exemption](hard-rules.md) of every file rule.

## What is not covered

- Merge commits that `git merge` creates by itself: it runs `pre-merge-commit`, which this
  repository does not provide. A merge that stops on conflicts is committed separately, and that
  commit runs `pre-commit`, so it is checked, against its first parent (HEAD): what the merged
  branch brings in counts as added.
- `git am` runs `pre-applypatch`, which this repository does not provide.
- Tested with git 2.54 (githooks documents `pre-commit` for `git commit` only): `git cherry-pick`,
  `git rebase` and `git revert` skip `pre-commit`, as does `git rebase --continue` after a
  conflict; a conflicted cherry-pick concluded with `--continue` or `git commit` runs it.
- `git commit --amend` compares against the commit being amended, so a file that commit added
  without the hook counts as existing.

Both hooks run the checker with `bun` from PATH or mise's pinned `bun`, and block without either.

## Sources

- [githooks](https://git-scm.com/docs/githooks) (`pre-commit`, `pre-merge-commit`,
  `pre-applypatch`).
- [gitattributes](https://git-scm.com/docs/gitattributes) and
  [git-check-attr](https://git-scm.com/docs/git-check-attr) (`--source`, to read the base).
- [Linguist overrides](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md)
  (`linguist-generated`).
- git's binary test: `buffer_is_binary` in
  [xdiff-interface.c](https://github.com/git/git/blob/master/xdiff-interface.c).
