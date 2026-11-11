# Hard rules

Part of [Git hooks](README.md).

Rules a machine enforces, with no allowlist and no inline override. One checker,
`scripts/ci/hard-rules.ts`, runs in three places, plus the commit-msg hook's message check
(`scripts/ci/commit-granularity.ts`):

- **commit-msg**: every non-merge commit message carries a `Revert-effect:` trailer (below).
  Merge commits are exempt; `--no-verify` skips it like the other hooks.
- **pre-commit**, `--staged`: the staged content against HEAD, and the author and the committer.
  The granularity diff rules do not run here — they judge a commit's message and diff
  together, and the index has no message yet.
- **pre-push** ([githooks](https://git-scm.com/docs/githooks#_pre_push)): per pushed ref, the file
  rules from the later of its fork points from the remote sha and from `origin/main` (the
  `origin/main` one when neither descends from the other), so a branch that merged or rebased onto
  main is not blamed for main's commits. A new ref, or a remote sha unknown locally, falls back to
  the merge base with `origin/main`. Identities are checked for the commits on neither the remote
  ref nor `origin/main` (`--authors-since` both). The granularity rules judge each commit the ref
  adds. A ref with no such base, or one the checker
  rejects as bad input (exit 2), gets a warning and no check; a deletion passes. If `main` was
  rewritten (force-pushed), a branch cut from a stale `origin/main` can pass the hook while CI's
  pull request check still blocks it.
- **CI**, `--range "$BASE" "$HEAD" --authors-since "$BEFORE"`: the always-run Plan checks job's
  "Check hard rules" step, with the `BASE` and `HEAD` that job diffs (a PR's base, or the head of
  the last successful push run on `main`). File rules judge from their merge base, as
  `git diff BASE...HEAD` does, so a later fixing commit cures the range. The identity rule checks
  a PR's `BASE..HEAD` but only a push's own commits (`BEFORE`, the push event's `before`; if that
  is not a commit, `BASE..HEAD`), so a bot commit on `main` fails one run, not every run. The
  granularity rules judge each commit in the range — this is the check a missing or bypassed hook
  cannot escape. `--all` skips them: it judges HEAD's tree state and history, not a change. With
  no base commit (no successful push run, a first push, a force push that removed the base, or a run
  a deploy or release workflow dispatched) the step warns and passes.

A violation exits 1 and lists, per rule, each `file:line` (or commit), what was found, and how to
fix it. Bad input (a malformed `skills-lock.json`, a base and head with no merge base) exits 2 with
one `hard-rules: <message>` line, prefixed `::error::` on GitHub Actions.

| Rule | Fails when |
| --- | --- |
| `size-ratchet` | The change adds a file over the 5,000-token limit, or one crosses or grows beyond it, by the [size limit table](size-limit.md) (in CI, the range's base in place of HEAD). |
| `markdown-lines` | A Markdown file the change adds or edits has 200 lines or more. Whole-tree mode checks every tracked Markdown file. |
| `markdown-links` | A relative link `](path)` in a Markdown file the change adds or edits names no tracked file or directory, or a link in any Markdown file names a path the change deletes or renames away. |
| `new-suppression` | An added line carries a lint, type-check or test suppression (list below). Existing ones are not flagged. |
| `author-identity` | The author or the committer looks like an Agent or bot (patterns below). |
| `migration-safety` | A migration the change adds has a high-risk statement and no valid safety annotation, a hash that no longer matches, a `rewrite` verdict, or no `lock_timeout` where one is required. See [Migration safety](migration-safety.md). |
| `migration-immutable` | The change edits, renames or deletes an `apps/web/prisma/migrations/*/migration.sql` that already exists on the base (HEAD for a commit, the range's base for CI). A new migration directory is allowed; the one approved unapplied-deletion list is described under [Migration safety](migration-safety.md#immutability). |
| `revert-effect` | A non-merge commit's message has no `Revert-effect:` trailer with a non-empty value (`none` is fine for docs and tests). |
| `rename-purity` | A commit's rename detection scores a rename below R100 — it moved and edited in one step. |
| `commit-mix` | A commit moves at least 30 deleted lines (20+ chars each) into new files and the non-move share of its changed lines is at least 40% — code extraction and a behavior change in one commit. |

**Markdown length.** Markdown means `.md`, `.mdx`, `.mdc`, and `.markdown`. A file must have
fewer than 200 lines: line 200 is already a violation. A final unterminated line counts, while a
trailing newline does not add an empty line. Change modes check added and edited Markdown only;
`--all` checks every tracked Markdown file. Split a long document into a topic directory with a
short `README.md` overview linking to focused files, move each section to its owning file, and
update incoming links.

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

**Commit granularity.** One commit does one thing (task #595). `Revert-effect:` is a message
trailer naming what reverting the commit would break, so a revert is a decision and not a guess;
`none` is the honest answer for docs and tests. `rename-purity` and `commit-mix` judge each
non-merge commit in a pushed or proposed range (pre-push and CI `--range`): a rename that also
edits splits into the pure rename and the edit, and an extraction that also changes behavior
splits into the move and the change. A move into an existing file is not detected, and an
extraction under 30 moved lines is not judged — five such commits in the last 200 were accepted
as known non-triggers. `Granularity-exempt: <reason>` in the message bypasses the two diff
rules only — `Revert-effect:` is still required — and each use is printed as a warning and
listed in the CI step summary. Merge commits skip all three rules.

**Reviewed-in warnings.** `scripts/ci/reviewed-in.ts` is the warn-only companion (task #593),
run by `scripts/ci/range-checks.ts` — the `--range` entrypoint pre-push and ci.yml share —
after the blocking rules:
a commit whose diff touches a path in `scripts/ci/high-risk-paths.txt` — protocol and
contract sources, credentials and secrets, auth, workflows, deploy and infra configuration —
should carry a `Reviewed-in: #<channel>:#<task>` trailer naming where it was reviewed (the
review message id may follow it). Each offending commit gets a `::warning::` and a step-summary
table in CI and a printed warning on pre-push; nothing fails. Commits carrying the trailer are
silent, and merge commits are skipped. Warn-only for its first two weeks while the false-positive
rate is measured; whether it becomes a hard rule is a later decision.

**Whitespace check.** `scripts/ci/diff-check.ts` is the blocking companion (task #628), run by
`range-checks.ts` after the hard rules: it applies the same `git diff --check` CI's "Select
checks" step runs, from the range's merge base, so pre-push refuses the trailing whitespace and
blank line at EOF that step would reject only after the push. It shares the hard rules' input
contract — bad input exits 2, no base warns and passes — and can only add failures, never
clear the hard rules' verdict.

**Hook installation.** `core.hooksPath=.githooks` is set once per clone, repo-wide, by the root
package's `prepare` script (`scripts/git-hooks/install-hooks-path.ts`) on every `bun install`;
linked worktrees share that config and resolve `.githooks` against their own top level, so a new
worktree is hooked as soon as it exists — run `bun install` there only if the path was never set.
`git commit --no-verify` and `git push --no-verify` skip the local hooks; CI's `--range` check is
the one that cannot be bypassed.

**The one exemption.** Files under a skill directory registered in `skills-lock.json`
(`.agents/skills/<name>/`, read from the change's base) are vendored upstream content: the
file rules (size, Markdown length and links, suppressions) skip them; the identity rule does not. Project skills that
are not in the lock are checked like any other file. This is the only exemption the hard rules
add. The size rule also keeps the two skips it was approved with (task #25): files marked
`linguist-generated` and binary files ([size limit](size-limit.md#files-that-are-not-checked)).

What the rules and the hooks do not catch is in [Limits](limits.md).

**Commit message rules from the root `AGENTS.md`.** Moved verbatim; the root keeps the `Revert-effect:` trailer rule.

One commit does one thing: a pure rename or code move never rides with a behavior change — split them, or mark a deliberate exception `Granularity-exempt: <reason>` ([hard rules](hard-rules.md#commit-granularity)). A commit touching a high-risk path ([the list](../../../scripts/ci/high-risk-paths.txt)) should also carry `Reviewed-in: #<channel>:#<task>`; missing it warns, never fails, for now.

## Sources

- [githooks](https://git-scm.com/docs/githooks#_pre_push) (`pre-push`).
- [git-var](https://git-scm.com/docs/git-var) (`GIT_AUTHOR_IDENT`) and
  [git-diff](https://git-scm.com/docs/git-diff) (`A...B` diffs from the merge base).
