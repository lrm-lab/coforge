---
name: coforge-verify
description: Prove a CoForge change works in the real running product before calling it done. Use when an Agent has finished a user-visible or runtime change (Web UI, conversations, Agents, Tasks, reminders, attachments, Daemon or Agent runtime behavior, the Computer CLI or installation, or a cloud deployment) and before it reports the work done, pushes to main, or asks for review. Routes the change to the right harness, uses the Feature Map to reach and drive the feature, and records an evidence artifact the commit message cites.
---

# CoForge verify

A change is done when it has been exercised in the running product and the
expected outcome was observed and recorded. Maintainers push straight to
`main`, so this proof is the quality gate. It supplements the repository rules
in [`AGENTS.md`](../../../AGENTS.md) (checks, TDD, commit record); it does not
replace them.

## What counts as proof

Proof is all three:

1. The changed feature ran in a real product process: a Web server serving the
   current build, an installed or freshly built Computer/Daemon, a real Agent
   runtime. The process was rebuilt and restarted after the change (see
   [Required rebuild and restart sequence](../../../docs/agents/e2e-testing/rebuild-and-restart.md)).
2. You drove it the way a user or Agent would and observed the outcome the
   change promises, including persistence after reload where the feature
   persists anything.
3. An artifact records it: `report.json` plus screenshots, traces or harness
   output (see [Evidence artifact](#evidence-artifact)).

These are not proof: compilation, type checks, lint, unit or fixture tests,
a green CI run, a model or tool claiming success, an ACK, a delivery log line,
an HTTP 200 on an unrelated route, or your own reading of the diff. They are
still required by `AGENTS.md`; they just do not establish that the feature works.

## Workflow

1. Name the features the change touches and open each entry in the
   [Feature Map](features/README.md). If none fits, write the entry first
   (see [Maintenance](#maintenance)).
2. Pick the route below and prepare its environment. Build every affected
   package, restart what loads it, and confirm the new build answers.
3. Drive the feature with the entry's controls. Wait on the observable
   completion it names, never on a sleep.
4. Observe the success signals the entry lists, plus the specific behavior your
   change adds. Check one negative or edge case when the change is a fix.
5. Write the artifact and cite it in the commit or CR (see below).
6. For a Web UI change, then report the affected UI as a Todo list for Frank to
   re-check, as [the UI verification policy](../../../docs/agents/testing.md#ui-verification-policy)
   requires. Your verification does not replace his; UI unit tests stay forbidden.

## Route by change type

| Change | Drive it with | Read first |
| --- | --- | --- |
| Web UI, conversations, Agents page, Tasks, Activity, reminders, attachments | The `ego-browser` skill against a local Web server or staging | [Feature Map](features/README.md), [Web environments](features/README.md#environments) |
| Daemon, Agent lifecycle, delivery, Agent runtime adapters | The native harnesses, then a real Agent turn through the Web | [Agent runtimes](features/agent-runtimes.md), [`docs/agents/e2e-testing/`](../../../docs/agents/e2e-testing/README.md) |
| Computer CLI, setup/attach, lifecycle commands, installer | The Computer setup and installer harnesses | [Computer](features/computer.md), [Native Linux setup](../../../docs/agents/e2e-testing/native-linux-setup.md) |
| Cloud deployment, Compose, Caddy, Centrifugo, release | The `coforge-release` skill | [Health verification](../../../docs/release/health-verification.md) |

A change that crosses rows needs each row's proof; for example a Daemon change
that alters what the Agent profile shows is verified natively and in the browser.

**Web UI.** Load the `ego-browser` skill (it is user-level, not in this
repository) and run `ego-browser skill` first. It drives the user's own
logged-in browser session, so sign-in is the user's; never type, paste, store,
or log credentials, tokens, or session cookies, and never put them in files,
command arguments, the report, or the commit. Before pushing, verify against a
local Web server built from your change. Staging (`https://staging.coforge.cn`)
runs only what an operator last dispatched from `main`, so use it to confirm a
change after its deployment, not to prove an unpushed one. Staging is shared:
work in a disposable Workspace or conversation and leave others' data alone.
The repository's scripted browser tests (`apps/web/test/*.e2e.ts`) use
`agent-browser`, a different tool; when one covers the feature, running it is
strong supporting evidence, and [the testing guidance](../../../docs/agents/testing.md#browser-end-to-end-tests)
lists its environment traps.

**Daemon and Agent runtimes.** Prefer the provider's native harness (for
example `packages/daemon/test/grok-native.e2e.ts`), then confirm one real turn
end to end: a message to an Agent on that runtime, its reply in the
conversation, and its Activity. Fixture and adapter unit tests do not count.
The native Computer harnesses are Linux/systemd only.

**Computer CLI and installation.** Use `scripts/e2e/run-computer-setup.sh`
(through `bun scripts/test/isolated-test-run.ts`) and
`scripts/e2e/installer-linux.sh` in a disposable OS user or the `coforge-linux`
orb, never on a machine whose Computer someone relies on.

**Cloud deployment.** Follow `coforge-release`; its health verification is the
proof, and it already defines the release evidence record.

## Evidence artifact

Write the artifact under `.amp/e2e/<feature>/`, where `<feature>` is the
Feature Map entry's slug (for example `.amp/e2e/agent-error-banner/`). The
root `.gitignore` ignores `.amp/e2e/` (and `.amp/in/artifacts/`, where some
harnesses put screenshots), so the artifact stays local and is never committed.
When a harness already writes its own artifact (for example
`.amp/e2e/grok-native/report.json` from `grok-native.e2e.ts`, or
`.amp/e2e/installer-linux/<UTC>/summary.md`), reference it instead of copying it.

`report.json` holds:

```json
{
  "feature": "agent-error-banner",
  "commit": "<git rev-parse HEAD of the build under test>",
  "version": "<app or Computer version that served it, when it has one>",
  "environment": "local http://127.0.0.1:8788 | staging https://staging.coforge.cn | native coforge-linux",
  "steps": ["opened /en/w/<slug>/agent/<id>", "..."],
  "observations": ["banner shows the provider error text", "..."],
  "artifacts": ["agent-error-banner.png", "harness: .amp/e2e/grok-native/report.json"],
  "outcome": "pass",
  "notes": "what was not covered, and why"
}
```

`outcome` is `pass` only when every step ran and every expected observation
held. Use `fail` for an observed defect and `incomplete` for a run that stopped
early or skipped a step. Record observations as facts you saw, not conclusions.
Redact every secret, token-bearing URL, and personal data before writing.

The commit that carries the change cites the artifact path and outcome in its
body, as `AGENTS.md` requires of a direct push's record, for example:
`Verified: .amp/e2e/agent-error-banner/report.json (pass, local 8788)`.
A CR cites the same line in its description. Name what was not verified.

## When verification fails

- Fix the product and verify again from a rebuilt, restarted process.
- Do not weaken the check to pass: no skipped steps, looser assertions, waits
  that hide a race, injected ACKs, overridden production instructions, or
  bypassed authorization (see
  [Diagnoses established during recovery](../../../docs/agents/e2e-testing/recovery-diagnoses.md)).
- Separate product defects from environment faults with evidence before
  changing anything; the Feature Map's traps list the known environment faults.
- Never report success from a partial run, a passing rerun of an unexplained
  failure, or a different scenario than the one changed. If you cannot reach a
  verifying environment, say the change is unverified and why; do not push it
  as done.

## Maintenance

- A change that alters how a feature is reached or controlled (a route, a
  label, a selector, a command, a flag, a harness) updates its Feature Map
  entry in the same change.
- When a run finds an entry wrong or stale, fix the entry in the change you are
  verifying, and mark anything you could not confirm as unverified.
- Keep each topic file under 200 lines; split an area before it grows past that.
