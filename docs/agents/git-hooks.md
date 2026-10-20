# Git hooks

The repository's git hooks live in `.githooks/`. `bun install` runs the root package's `prepare`
script, `scripts/git-hooks/install-hooks-path.ts`, which sets the repository-local `core.hooksPath`
to `.githooks`. Git resolves a relative hooks path from the root of the work tree, so the one
setting serves every worktree. The installer does nothing outside a git work tree (a Docker build
context, an unpacked tarball). It leaves an existing `core.hooksPath` of yours alone and prints one
line; point that hooks directory at `.githooks/pre-commit` yourself. A CoForge Agent's own hook
shims forward to the repository's hooks directory, so Agents run these hooks too.

In a fresh clone or worktree, no hook runs until the first `bun install` (`--ignore-scripts` skips
`prepare`); `mise run check` [reports that](#limits). `.gitattributes` keeps `.githooks/*` at
`text eol=lf`, so a `core.autocrlf=true` checkout (Git for Windows) gets no CRLF in the hook.

The repository uses plain `core.hooksPath`, not a hook manager: husky overwrites an existing
`core.hooksPath`, lefthook needs a postinstall Bun runs only for trusted packages, and the ratchet
would be custom code either way.

`.githooks/pre-commit` runs the [hard rules](#hard-rules) (`scripts/ci/hard-rules.ts --staged`)
on the content being committed, the file size limit below among them, and reports every
violation before failing.

## Pre-commit: file size limit

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
staged sizes in bytes for one that crossed the limit or grew. Split the file into smaller ones.

### Files that are not checked

- **Generated files.** A file whose `linguist-generated` attribute is set in the base's root
  `.gitattributes` ([read from the base](#limits)) is skipped: lockfiles and generated code. On
  GitHub the same attribute also excludes the file from language statistics and suppresses it in
  diffs. Mark a file only if a tool genuinely produces it, never to get an agent-written file past
  the limit. Translation files under `apps/web/messages/` are agent-written and stay checked.
  `git check-attr --source=<base> linguist-generated -- <path>` shows the value at a base.
- **Binary files.** A file with a NUL byte in its first 8,000 bytes, the test git's own
  `buffer_is_binary` applies.
- **Vendored skills.** Files under a skill directory registered in `skills-lock.json`, the
  [one exemption](#hard-rules) of every file rule.

### What is not covered

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

The hook runs the checker with `bun` from PATH, or mise's pinned `bun`. When it finds neither, it
blocks the commit and says so.

## Hard rules

Rules a machine enforces, with no allowlist and no inline override. One checker,
`scripts/ci/hard-rules.ts`, runs in two places:

- **pre-commit**, `--staged`: the staged content against HEAD, and the author and the committer.
- **CI**, `--range "$BASE" "$HEAD" --authors-since "$BEFORE"`: the "Check hard rules" step of the
  always-run Plan checks job, with the same `BASE` and `HEAD` that job diffs (a PR's base, or the
  head of the last successful push run on `main`). The file rules judge the change from their
  merge base, as `git diff BASE...HEAD` does, so a later commit that fixes a violation cures the
  range. The identity rule checks a PR's `BASE..HEAD`, but only the commits a push introduced
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
| `author-identity` | The author or the committer looks like an Agent or bot (patterns below). |

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

**Author identity.** The author's and the committer's name or email, case-insensitively, matching
`coforge-*`, `*@anthropic.com`, `*@ampcode.com`, `*@coforge.local`, `cursoragent@cursor.com`,
`*[bot]` or `*-agent@*`, or a name matching `^(gpt|glm|claude|gemini|qwen|deepseek|kimi|grok|llama|muse)-[0-9]`
(so `GPT4all`, `llama3` and `claude` alone pass). No allowlist: GitHub's web-merge committer
`GitHub <noreply@github.com>` matches nothing. Pre-commit reads `git var GIT_AUTHOR_IDENT` and
`GIT_COMMITTER_IDENT` (`--author`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*` included); CI reads both for
the commits above. `Co-authored-by` trailers are not checked. Commit as the person running the
Agent (root `AGENTS.md`).

**The one exemption.** Files under a skill directory registered in `skills-lock.json`
(`.agents/skills/<name>/`, read from the change's base) are vendored upstream content: the
file rules (size, links, suppressions) skip them; the identity rule does not. Project skills that
are not in the lock are checked like any other file. This is the only exemption the hard rules
add. The size rule also keeps the two skips it was approved with (task #25): files marked
`linguist-generated` and binary files, [above](#files-that-are-not-checked).

### Limits

- The hook is local: `git commit --no-verify` skips it, and a clone or worktree has none until
  `bun install`. The local backstop is `mise run check` (`bun run check`), which root `AGENTS.md`
  requires before every push. Its first step, `scripts/ci/local-gate.ts`, fails unless
  `core.hooksPath` is `.githooks` (a hooks path of your own passes only if its `pre-commit` runs
  `.githooks/pre-commit`), and runs CI's range check on the commits not yet on your local
  `origin/main`. Without `origin` or `origin/main` it says so and skips that part; a stale
  `origin/main` can list others' commits, so a failure names its base and asks for
  `git fetch origin`. It changes no config, and does nothing with `CI=true` or outside a work tree.
  It is still a convention: nothing runs `mise run check` before `git push`.
- A maintainer or an Agent may push directly to `main` (root `AGENTS.md`); CI validates a push only
  afterwards, so a violation that got past the hook and the gate is reported once on `main`, and
  its author fixes it before pushing anything else. A PR cannot merge without "CI passed".
- Merges, rebases (`--continue` included), reverts, `git am` and a conflict-free cherry-pick do
  not run `pre-commit` ([details](#what-is-not-covered)).
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

## Sources

- git hooks: [githooks](https://git-scm.com/docs/githooks) (`pre-commit`, `pre-merge-commit`,
  `pre-applypatch`, and the directory hooks run in).
- [git-var](https://git-scm.com/docs/git-var) (`GIT_AUTHOR_IDENT`) and
  [git-diff](https://git-scm.com/docs/git-diff) (`A...B` diffs from the merge base).
- [`core.hooksPath`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
  in git-config.
- [gitattributes](https://git-scm.com/docs/gitattributes) (`text`, `eol`, pattern matching) and
  [git-check-attr](https://git-scm.com/docs/git-check-attr) (`--source`, to read the base).
- [Linguist overrides](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md)
  (`linguist-generated`).
- [`bun install`](https://bun.com/docs/pm/cli/install) (the project's lifecycle scripts,
  `--ignore-scripts`, and trusted dependencies).
- git's binary test: `buffer_is_binary` in
  [xdiff-interface.c](https://github.com/git/git/blob/master/xdiff-interface.c).
- husky's install step: [index.js](https://github.com/typicode/husky/blob/main/index.js).
