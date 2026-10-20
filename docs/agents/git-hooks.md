# Git hooks

The repository's git hooks live in `.githooks/`. `bun install` runs the root package's
`prepare` script, which runs `scripts/git-hooks/install-hooks-path.ts`. That script sets the
repository-local `core.hooksPath` to `.githooks`. Git resolves a relative hooks path from the
directory hooks run in, which is the root of the work tree, so the one setting serves every
worktree. The installer does nothing outside a git work tree (a Docker build context, an unpacked
tarball). It leaves an existing `core.hooksPath` of yours alone and prints one line instead; point
that hooks directory at `.githooks/pre-commit` yourself if you want the checks. A CoForge Agent's
own hook shims forward to the repository's hooks directory, so Agents run these hooks too.

In a fresh clone or worktree, no hook runs until the first `bun install`, and
`bun install --ignore-scripts` skips `prepare`, so it leaves the hook off. `.gitattributes` keeps
`.githooks/*` at `text eol=lf`, so a `core.autocrlf=true` checkout (Git for Windows) does not give
the `#!/bin/sh` hook CRLF line endings.

The repository uses plain `core.hooksPath` rather than a hook manager. husky sets
`core.hooksPath` without checking for an existing value, which must be left alone. lefthook adds a
dependency whose postinstall Bun does not run unless the package is trusted. Either way the
ratchet itself would still be custom code.

`.githooks/pre-commit` runs the [hard rules](#hard-rules) (`scripts/ci/hard-rules.ts --staged`)
on the content being committed, the file size limit below among them, and reports every
violation before failing.

## Pre-commit: file size limit

A commit may not add agent-written files over **5,000 tokens**, estimated as bytes / 4: the limit
is 20,000 bytes, so a file of exactly 20,000 bytes is allowed and one of 20,001 is not. The check
(`scripts/git-hooks/staged-file-size.ts`, run by the hard-rules checker) reads the staged blobs, the content being committed,
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
- **Vendored skills.** Files under a skill directory registered in `skills-lock.json`, the
  [one exemption](#hard-rules) of every file rule.

### What is not covered

- `git commit --no-verify` skips the hook for one commit. CI runs the same ratchet over the
  pushed or proposed range as a [hard rule](#hard-rules), after the fact.
- Merge commits that `git merge` creates by itself: it runs `pre-merge-commit`, which this
  repository does not provide. A merge that stops on conflicts is committed separately, and that
  commit runs `pre-commit`, so it is checked, against its first parent (HEAD): what the merged
  branch brings in counts as added.
- `git am` runs `pre-applypatch`, which this repository does not provide.
- Commits that `git cherry-pick`, `git rebase` and `git revert` create themselves did not run
  `pre-commit` when this was tested with git 2.54 (githooks documents `pre-commit` for
  `git commit` only). A step that stopped on conflicts and was concluded with `git commit` or
  `--continue` did run it.
- `git commit --amend` compares against the commit being amended, so a file that commit added
  without the hook counts as existing.

The hook runs the checker with `bun` from PATH, or mise's pinned `bun`. When it finds neither, it
blocks the commit and says so.

## Hard rules

Rules a machine enforces, with no allowlist and no inline override. One checker,
`scripts/ci/hard-rules.ts`, runs in two places:

- **pre-commit**, `--staged`: the staged content against HEAD and the author of the commit being
  made.
- **CI**, `--range "$BASE" "$HEAD" --authors-since "$BEFORE"`: the "Check hard rules" step of the
  always-run Plan checks job, with the same `BASE` and `HEAD` that job diffs (a PR's base, or the
  head of the last successful push run on `main`). The file rules judge the change from their
  merge base, as `git diff BASE...HEAD` does, so a later commit that fixes a violation cures the
  range. The author rule checks a PR's `BASE..HEAD`, but only the commits a push introduced
  (`BEFORE`, the push event's `before`): a bot commit on `main` fails its own push's run, not
  every run until `main` is rewritten. A `before` that is not a commit (empty, all zeros, or
  force-pushed away) falls back to `BASE..HEAD`. With no base commit (no successful push run yet,
  a first push, a force push that removed the base, or a run dispatched by a deploy or release
  workflow) the step prints a warning and passes.

A violation exits 1 and lists, per rule, each `file:line` (or commit), what was found, and how to
fix it. Bad input (a malformed `skills-lock.json`, a base and head with no merge base) exits 2 with
one `hard-rules: <message>` line, prefixed `::error::` on GitHub Actions.

| Rule | Fails when |
| --- | --- |
| `size-ratchet` | The change adds a file over the 5,000-token limit, or one crosses or grows beyond it, by the table above (in CI, the range's base in place of HEAD). |
| `markdown-links` | A relative link `](path)` in a Markdown file the change adds or edits names no tracked file or directory, or a link in any Markdown file names a path the change deletes or renames away. |
| `new-suppression` | An added line carries a lint, type-check or test suppression (list below). Existing ones are not flagged. |
| `author-identity` | The author looks like an Agent or bot (patterns below). |

**Links.** Inline links, whose destination may hold balanced parentheses (`foo_(bar).md`), and
reference definitions: `[label]: path` alone on its line or followed only by a quoted or
parenthesized title, so `[TODO]: decide this later` is not one, nor is a `[^note]:` footnote.
Fenced code blocks (also indented in a list item or behind `>` in a block quote; a line opening
with ```` ```bash``` ```` is inline code, not a fence), inline code and HTML comments (a
multi-line one only when `<!--` starts its line) are skipped. So are `\[text\](path)`, URLs
with a scheme (`mailto:` included) and pure `#anchor` links;
indented code blocks and HTML such as `<a href>` are not parsed, so a link in either is checked or
missed as text. A `#fragment` or `?query` is dropped, the rest is
percent-decoded and resolved against the file's directory; a leading `/` is the repository root.
The target must exist in the index (pre-commit) or the head commit (CI), never only in the working
tree. Whole-tree mode, `bun scripts/ci/hard-rules.ts --all`, checks every link in HEAD's Markdown
and every author in HEAD's history.

**Suppressions.** After a comment opener (`//`, `/*`, `<!--`), or at the start of a line (after
any `*`, as inside a block comment) in JavaScript/TypeScript, Vue, Svelte, CSS/SCSS/Less and Rust
files only (so prose in `.txt`, YAML or a heredoc is not flagged), directives that start with `oxlint-disable`, `eslint-disable`,
`biome-ignore`, `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`; in Rust, `#[allow(`,
`#![allow(`, `#[expect(` and `#![expect(`; in JavaScript or TypeScript test files
(`*.test.*`, `*.spec.*`, `*.e2e.*`, `*.integration.*`, or under a `test/`, `tests/` or
`__tests__/` directory), any `.skip` or `.only` call, `.each` and tagged-template forms included.
Not covered: `test.skipIf`, `test.todo`, and `xit(`, `fit(` or `xdescribe(`, which would also
match ordinary functions of those names. Markdown (`.md`, `.mdx`, `.mdc`, `.markdown`) is
link-checked and may name every token. A `.skip(` inside a string literal in a test file is
flagged too. Every file is read as text (`git diff --text`), so a
`-diff` attribute or a NUL byte does not hide a line.
A suppression the change also removes from a checked file (not Markdown, not a vendored skill)
was moved or edited around, not added. The pairing spans the whole change, not one file, because a
file split moves suppressions between files: removing one from file A lets an identical new one
into file B. It is matched by the directive through the end of its line,
or by the `.skip(` or `.only(` call alone: splitting a file, widening a dependency list beside an
`eslint-disable-line`, or renaming a skipped test passes, but a second identical one is new. A new
generated file whose generator writes a suppression header (such as `/* eslint-disable */`) is
blocked when it is first committed; regenerating it later is not, because that line is unchanged.
A new exemption needs the user's explicit prior approval (root `AGENTS.md`, Decision gates); fix
the underlying code instead.

**Author identity.** The author's name or email, case-insensitively, matching `coforge-*`,
`*@anthropic.com`, `cursoragent@cursor.com`, `*[bot]` or `*-agent@*`.
Pre-commit reads `git var GIT_AUTHOR_IDENT`, which reflects `--author` and `GIT_AUTHOR_*`; CI
reads the commits above. The committer and `Co-authored-by` trailers are not checked.
Commit as the person running the Agent (root `AGENTS.md`).

**The one exemption.** Files under a skill directory registered in `skills-lock.json`
(`.agents/skills/<name>/`, read from the change's own result) are vendored upstream content: the
file rules (size, links, suppressions) skip them; the author rule does not. Project skills that
are not in the lock are checked like any other file. This is the only exemption the hard rules
add. The size rule also keeps the two skips it was approved with (task #25): files marked
`linguist-generated` and binary files, [above](#files-that-are-not-checked).

### Limits

- The hook is local. `git commit --no-verify` skips it, and a clone or worktree has no hook until
  `bun install` runs (see above), so a violation can still be committed.
- A maintainer or an Agent may push directly to `main` (root `AGENTS.md`), and CI validates a push
  only afterwards: it blocks nothing, so a violation is reported once it is already on `main`. Its
  author fixes it before pushing anything else, as for any red run on `main`. A PR cannot merge
  without the "CI passed" check, so there the step blocks.
- Merges without conflicts, `git cherry-pick`, `git rebase`, `git revert` and `git am` do not run
  `pre-commit` (see [What is not covered](#what-is-not-covered)), so only CI checks those commits.
- A CI run without a base commit only warns, so that range is never checked.
- A push run cancelled by a newer push loses its author check. The newer push's `before` is the
  cancelled push's head, so the cancelled push's commits are in no run's author range; the file
  rules still cover them, because the next run diffs from the last successful one.
- A violation in CI fails the Plan checks job, so the checks it would have selected are skipped
  until the violation is fixed.
- The exemption lists, `skills-lock.json` and `.gitattributes`, are read from the change itself,
  so a change can add its own exemption; only review catches that.
- A line inside a template string that starts with a suppression directive is flagged.

## Sources

- git hooks: [githooks](https://git-scm.com/docs/githooks) (`pre-commit`, `pre-merge-commit`,
  `pre-applypatch`, and the directory hooks run in).
- [git-var](https://git-scm.com/docs/git-var) (`GIT_AUTHOR_IDENT`) and
  [git-diff](https://git-scm.com/docs/git-diff) (`A...B` diffs from the merge base).
- [`core.hooksPath`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
  in git-config.
- [gitattributes](https://git-scm.com/docs/gitattributes) (`text`, `eol`, pattern matching) and
  [git-check-attr](https://git-scm.com/docs/git-check-attr) (`--cached`, and `--source` for CI's
  head commit).
- [Linguist overrides](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md)
  (`linguist-generated`).
- [`bun install`](https://bun.com/docs/pm/cli/install) (the project's lifecycle scripts,
  `--ignore-scripts`, and trusted dependencies).
- git's binary test: `buffer_is_binary` in
  [xdiff-interface.c](https://github.com/git/git/blob/master/xdiff-interface.c).
- husky's install step: [index.js](https://github.com/typicode/husky/blob/main/index.js).
