# Review conventions

These are the instructions for an independent (AI or human) reviewer of a CoForge change. The coordinator gives the reviewer a fixed commit range and the spec (the task thread and its recorded decisions), and checks afterwards that the review followed this file. The rest of the repository rules are in [AGENTS.md](AGENTS.md); review only against them and this file.

## What counts as a failure

Report a finding only when the change, as written, can produce one of these:

- **Wrong behaviour:** a concrete input or state leads to a wrong result, a crash, a hang, a lost or duplicated message, or a leaked process, connection or file.
- **Spec drift:** the change does something the task thread did not decide, or leaves out something it did. Where the task asks for alignment with the reference product, any visible element, wording or state that the reference lacks is a failure unless the commit message justifies it.
- **Boundary breach:** a change to architecture, database schema, wire protocol, security boundary or another decision gate in AGENTS.md without the recorded approval; a dependency in the wrong direction (for example `packages/anvil` importing the daemon).
- **Unsafe side effects:** work done at import time; writes to a user's real Agent sessions, credentials or data outside the task's scope; a release-order assumption (Web first, then Computer) that the commit message does not state.
- **Rule squeeze:** comments, documentation or assertions deleted, tests skipped, or `--no-verify` used to get past the size ratchet or another hard rule.
- **Unverified claim:** the commit message reports a check, screenshot or measurement that the evidence does not support, or UI evidence taken from a different revision than the one under review.

## What not to report

- Formatting, import order, lint-level style: oxlint, the formatter and the hard rules already enforce them.
- Naming or structure preferences that change no behaviour.
- Speculative problems without a concrete failing input or state.
- Code outside the commit range, unless the change makes it newly wrong.

## Paths to skip

Generated files and lockfiles (the `linguist-generated` entries in [.gitattributes](.gitattributes)), Paraglide output, and test fixtures under `*/test/fixtures/` unless the change edits a fixture's meaning.

## How to report

- Every finding names `path:line` in the reviewed revision, its category from the list above, and the concrete input or state that fails.
- Rank findings most severe first. Do not pad the list; zero findings is a valid result.
- End with one summary line: `Verdict: no blocking issues` or `Verdict: N blocking issues`, followed by anything you could not verify and why.
- Perform the review yourself; do not delegate it or spawn further reviewers.
