# Git hooks

The repository's git hooks live in `.githooks/`. `bun install` runs the root package's `prepare`
script, `scripts/git-hooks/install-hooks-path.ts`, which sets the repository-local `core.hooksPath`
to `.githooks`. Git resolves a relative hooks path from the root of the work tree, so the one
setting serves every worktree. The installer does nothing outside a git work tree (a Docker build
context, an unpacked tarball). It leaves an existing `core.hooksPath` of yours alone and prints one
line; have your hooks call `.githooks/pre-commit` and `.githooks/pre-push` yourself. A CoForge
Agent's own hook shims forward to the repository's hooks directory, so Agents run these too.

In a fresh clone or worktree, no hook runs until the first `bun install` (`--ignore-scripts` skips
`prepare`); `mise run check` [reports that](limits.md). `.gitattributes` keeps `.githooks/*` at
`text eol=lf`, so a `core.autocrlf=true` checkout (Git for Windows) gets no CRLF in the hook.

The repository uses plain `core.hooksPath`, not a hook manager: husky overwrites an existing
`core.hooksPath`, lefthook needs a postinstall Bun runs only for trusted packages, and the ratchet
would be custom code either way.

`.githooks/pre-commit` runs the [hard rules](hard-rules.md) on the content being committed (the
[file size limit](size-limit.md) among them), and `.githooks/pre-push` on what a push sends; each
reports every violation before failing.

## Topics

- [Pre-commit: file size limit](size-limit.md): the 5,000-token ratchet, resolving a block by
  splitting at natural seams, the files it skips, and the git operations that do not run `pre-commit`.
- [Hard rules](hard-rules.md): where the checker runs (pre-commit, pre-push, CI), its rules, and
  the one exemption.
- [Limits](limits.md): what the hooks, the `mise run check` gate and CI do not catch, and where
  the exemption lists are read from.

## Sources

- git hooks: [githooks](https://git-scm.com/docs/githooks) (`pre-commit`, `pre-push`,
  `pre-merge-commit`, `pre-applypatch`, and the directory hooks run in).
- [`core.hooksPath`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
  in git-config.
- [gitattributes](https://git-scm.com/docs/gitattributes) (`text`, `eol`, pattern matching).
- [`bun install`](https://bun.com/docs/pm/cli/install) (the project's lifecycle scripts,
  `--ignore-scripts`, and trusted dependencies).
- husky's install step: [index.js](https://github.com/typicode/husky/blob/main/index.js).
