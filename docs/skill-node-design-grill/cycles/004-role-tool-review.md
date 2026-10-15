# Cycle 004 — Four-role tool and function review

**Status:** `open`
**Opened:** 2026-10-14
**Closed:** —
**Extends:** cycle 003; ADR-0043; external ADR-0044 and ADR-0045
**Formal sources updated:** none

## Git version

| Point | Repository | Branch | Commit | Worktree | Tree |
|---|---|---|---|---|---|
| Before grill | `/data/zhoujie/river2_0-main/coforge-bcrr-tool-review` | `docs/bcrr-tool-review` | `5e96ad6a2a3792489d9ca02cd6a26c83d18c9047` | `/data/zhoujie/river2_0-main/coforge-bcrr-tool-review` | `dirty` |
| After implementation | none | none | none | none | — |

The before-grill SHA is the latest commit. The copied engagement archive and this review are uncommitted and outside that commit. The reviewed OpenViking worktree is also dirty at `510ec461007fbdc4237d64b34656a158b661f215`; its uncommitted files, including the real-model role adapter, are outside that SHA.

## Scope

The first pass reviewed Builder, Critic, Refiner, and Reader in the OpenViking AIG feature branch. The requester then corrected the scope to the current CoForge and OpenViking local `main` branches. The [main-only review](../review/main-branches-20261014.md) controls the current assessment; the original [feature-branch review](../review/role-tools-20261014.md) remains evidence for that branch only. This cycle makes no product implementation decision and does not authorize code changes.

## Frontier and answers

| ID | Decision | Answer | Evidence or rationale |
|---|---|---|---|
| Q236 | What should happen when Critic's semantic audit fails or cannot produce a valid result? | Withdrawn from the current main-only frontier after the requester corrected the reviewed branch. | The failure was reproduced in the OpenViking feature branch only; local main has no Critic provider. Preserve the finding for future integration review. |

## Findings

See the [main-only review](../review/main-branches-20261014.md) for the current status. The [feature-branch review](../review/role-tools-20261014.md) has a separate baseline. The four-role implementation gap on main is factual; an integration decision has not been requested or made.

## Decisions

| ID | Decision | Formal source | Delivery consequence |
|---|---|---|---|
| — | No answer yet. | none | No delivery authorized. |

## Rejected assumptions

- A `Phi(G)=0` result proves semantic or causal fidelity. It checks structure only.
- A terminal Critic provider failure is a clean semantic audit.
- A frozen Reader report necessarily contains verified decisive evidence.
- The four-role toolloop is the default production session-commit path. The current commit hook still documents deterministic fallback or injected single-pass extraction.

## Register changes

- Opened OQ-004 for Q236 and OQ-005 for the follow-on Reader verification contract; both are now deferred to feature-branch integration review after the scope correction.
- Added R-003 through R-006 for silent approval, unrepairable violations, attribution trust, and AO read disclosure.
- No delivery cycle was prepared.

## Next trigger

The requester reviews the main-only assessment. Reopen Q236 and Reader-report questions only if a named feature-branch integration is proposed. After the frontier is empty and the user confirms shared understanding, close this cycle under host rules.
