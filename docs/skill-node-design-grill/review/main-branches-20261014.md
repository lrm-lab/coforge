# Four-role status on the local main branches

**Scope correction (2026-10-14):** This note reviews the local `main` refs only. The preceding [feature-branch tool review](role-tools-20261014.md) describes OpenViking `feat/aig-native-fork-overlay`; its 19-verb surface and probe findings do not describe either local main branch.

## Versions and source boundaries

- CoForge local `main`: `6870b17ff0a73b3f1d8c1151d43ff9cf2b0695d1`; local `origin/main` tracking ref: `d7ac4fc8067b174fd103b3d891cf7845e2147076`.
- OpenViking local `main`: `ebd2df04ed9d8d811e8477eb752c95f0721301d4`; local `origin/main` tracking ref: `0f8c5c538ceb99efd072947a71b20b90db644727`.
- A live remote check failed because the configured proxy at `127.0.0.1:7893` was unavailable. These SHAs are local refs, not a claim about the server's current HEAD. The inspected CoForge checkout is on `fix/evoagentbench-docker-pool-20261014`; all CoForge source below was read via `git show main:<path>`. OpenViking's inspected checkout is on `main` and clean.

## What each main actually provides

| Role | Local main implementation | Model-callable tool catalog |
|---|---|---|
| Builder | OpenViking `AigConstructionRun.submit_draft` records a draft hash; `InfluenceViewDraft` supports add block/claim/subgraph and a separate single-pass extraction provider. The commit hook uses deterministic fallback without a provider or one injected extraction call. | None for the AIG Builder. No `T_log`/`T_build` toolloop module on local main. |
| Critic | `AigConstructionRun.critique` records any list of violations and enforces at most three rounds. `InfluenceViewDraft.validate_view` checks structural validity. | None for the AIG Critic. No semantic-audit provider/loop on local main. |
| Refiner | `AigConstructionRun.refine` records the next draft hash; `InfluenceViewDraft.apply_critic_patch` replaces selected block/claim/coverage collections and records provenance. | None for the AIG Refiner. No violation-scoped model tool catalog on local main. |
| Reader | `AigConstructionRun.read_verify`, `escalate_evidence`, `freeze_report`, and `propose_fork` enforce session and phase transitions. | None for the AIG Reader. No navigation toolloop or `T_fork` surface on local main. |

`AigConstructionRun` is referenced in production source only by its own definition; the other observed consumers are tests. OpenViking `RoleRetrievalService` recognizes `builder|critic|refiner|reader|diagnosis` as authorized role labels for semantic/exact retrieval, but that is an in-process retrieval contract, not an exposed four-role tool inventory. The local `origin/main` tracking ref of OpenViking lacks these custom AIG modules altogether.

CoForge local `main` has no Builder/Critic/Refiner/Reader runtime or tool catalog. Its Memory Agent is a different role. That Agent has `ov_find`, `ov_search_context`, `ov_read`, `memory_offer`, plus channel message tools; the SDK caps three memory reads and one offer per trigger. CoForge's local `origin/main` tracking ref still has no four-role runtime, although Memory Agent wiring differs from local `main`.

## Main-only assessment

The role-session isolation, three-round cap, fallback state, and Reader phase order in OpenViking are sensible foundations. They do not implement the proposed four-role behavior. `critique` accepts arbitrary violation objects; `read_verify` hashes arbitrary report content and `freeze_report` marks it frozen; `propose_fork` checks only the presence of a `fork` key. Because the class is not wired as a production role runner, these are **contract gaps**, not demonstrated production exploit paths. A trustworthy implementation still needs role-specific tool surfaces, evidence/semantic checks, persistence, and an authorized cross-repository integration into CoForge.

The feature-branch findings (Critic failure becoming empty violations, Reader zero-read reports, prompt disclosure through `T_log`, and Refiner repair limits) remain relevant **only when reviewing or considering that feature branch for integration**. They cannot be attributed to main.

Validation: OpenViking local main `tests/test_aig_role_chain.py` passed 9 tests. No CoForge product code was changed. No four-role end-to-end test exists in the inspected main code.
