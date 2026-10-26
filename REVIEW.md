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

## What to check, by kind of change

Each item is a way a CoForge change has already failed, and names the category above it falls under.

**Any change**

- A fix that hides the symptom (a retry, a longer timeout, a swallowed error, a hidden element) without the commit naming the cause and removing it: wrong behaviour.
- An error that reports a cause the code did not establish, such as a network timeout reported as an authorization failure that tells the person to upgrade: wrong behaviour.
- A file split to get under the size ratchet by moving a block verbatim into a second file, instead of giving each file one responsibility: rule squeeze.

**Protocol, SDK and stored data**

- A protocol change that keeps the old field or message beside the new one with no recorded end date, instead of replacing it: spec drift.
- A decoder that quietly supplies a default for a field the contract requires: wrong behaviour.

**Runtime adapters (`packages/anvil`, daemon code agents)**

- Vendor runtimes live in Anvil behind host ports; only the built-in CoForge Agent stays in the daemon. Anvil code that imports the daemon or builds platform or environment defaults itself: boundary breach.
- A runtime that departs from the policy the existing runtimes share (permission mode, approval answers, tools kept, version gate, never downloading the CLI on its own) without a stated reason: spec drift.
- Probing, launching or scanning a runtime that writes to the person's real sessions, profile or credentials: unsafe side effect.
- A process a turn started that survives the turn's interrupt or exit: wrong behaviour.

**Web UI**

- On an alignment task, every visible element, wording and state is compared with the reference product's live site, not only its code bundle, and each difference is labelled aligned, differs (with the reason) or unverifiable. An unlabelled difference, or an element the reference lacks: spec drift.
- A secondary label or hint that repeats what the layout already says: spec drift. An element the reference does have is kept, even if it looks redundant.
- Screenshots that are not from the reviewed revision, or show only the easy state. Evidence covers realistic data and the states that change layout: long names, empty, error, a 390 px phone, English and Chinese. Anything else is an unverified claim.

**Tests**

- A flaky test "fixed" by a longer timeout instead of waiting on an observable condition: wrong behaviour. A deleted or weakened assertion: rule squeeze.

**Release, installer and CI**

- Release notes that cover Web changes, name the reference product, or describe implementation instead of the user-visible effect: spec drift ([docs/release/release-notes.md](docs/release/release-notes.md)).
- A change to the installer, signing, release or CI workflows without Frank's recorded approval: boundary breach.

## What not to report

- Formatting, import order, lint-level style: oxlint, the formatter and the hard rules already enforce them.
- Naming or structure preferences that change no behaviour.
- Speculative problems without a concrete failing input or state.
- Code outside the commit range, unless the change makes it newly wrong.
- Missing unit tests where an E2E test or a screenshot artifact covers the behaviour: the repository prefers E2E tests ([AGENTS.md](AGENTS.md#testing)).

## Paths to skip

Generated files and lockfiles (the `linguist-generated` entries in [.gitattributes](.gitattributes)), Paraglide output, and test fixtures under `*/test/fixtures/` unless the change edits a fixture's meaning.

## How to report

- Every finding names `path:line` in the reviewed revision, its category from the list above, and the concrete input or state that fails.
- Rank findings most severe first. Do not pad the list; zero findings is a valid result.
- End with one summary line: `Verdict: no blocking issues` or `Verdict: N blocking issues`, followed by anything you could not verify and why.
- Perform the review yourself; do not delegate it or spawn further reviewers.

## Keeping this file current

When a reviewed change later turns red on main, is reverted, or fails in production, or a reviewer reports something that is not a failure, the coordinator adds the lesson here: a check under the kind of change it belongs to, or an entry under what not to report.
