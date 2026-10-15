# Cycle 003 — Default Memory Agent Per Group

**Status:** `closed`
**Opened:** 2026-10-13
**Closed:** 2026-10-13
**Extends:** ADR-0016; CONSENSUS #15; cycle 002 remains closed
**Formal sources updated:** [CONSENSUS.md](../CONSENSUS.md) `default-memory-agent/Q217–Q235`；[CONTEXT.md](../CONTEXT.md) 的群 Memory Agent。ADR-0016 仅加取代说明，未新建 ADR。

## Git version

| Point | Repository | Branch | Commit | Worktree | Tree |
|---|---|---|---|---|---|
| Before grill | `/home/zhoujie22/river2_0/coforge` | `main` | `6eb2a1b516e74b2783ec9bfcec0a5ce525703e30` | `/home/zhoujie22/river2_0/coforge` | `dirty` |
| After implementation | `/home/zhoujie22/river2_0/coforge` | `main` | `fde7658e7846a676e243083167f8cb676a97331d` | `/home/zhoujie22/river2_0/.worktrees/coforge-default-memory-agent` | `clean` |

The SHA is the latest commit. Uncommitted files, including this engagement, are not part of it.

## Scope

Decide what “every group chat has a Memory Agent by default” requires beyond ADR-0016. Q228 B supersedes the part of ADR-0016 and CONSENSUS #15 that provisions a separate Memory Agent identity for each new group. One workspace has one Memory Agent, provisioned with handle `memory` when a new group is created and that handle is free; later new groups then add that member. Q229 C: when a live agent or a member username already holds `memory`, that new group is created without a Memory Agent, and that creation does not switch the profile. Q230 A: after the handle becomes free, the next new group provisions `@memory` and attempts the profile switch. Q231 A: groups created while the handle was taken do not then receive that member. Q232 A: renaming the provisioned agent does not start a second provision; later new groups add that same agent. Q233 A: soft-deleting that record lets the next new group provision a new `@memory` with a new identity. Q234 A: groups that had the deleted agent do not automatically receive that new member. Q235 A: a later change to private visibility is refused. The user confirmed the shared understanding on 2026-10-13. This cycle does not reopen the disposition receipt, retrieval, or product implementation.

## Frontier and answers

| ID | Decision | Answer | Evidence or rationale |
|---|---|---|---|
| Q217 | Does every group chat have a Memory Agent by default? | Yes. Each group chat has a Memory Agent by default. | User statement on 2026-10-13. ADR-0016 already requires this for a newly created group and leaves existing groups, removal, budget, and silence unset. |
| Q218 | Existing group chats. | B. Only groups created after this decision receive a Memory Agent. Existing groups stay unchanged. | User answer on 2026-10-13. |
| Q219 | Removal after the default membership. | A. The Memory Agent may be removed. That group then has none until one is added again. | User answer on 2026-10-13. |
| Q220 | Workspace memory profile at creation. | B. Creating the Memory Agent also sets that Workspace's desired memory profile to `openviking`. | User answer on 2026-10-13. |
| Q221 | Ingestion after the profile switches. | A. Existing workspace-profile semantics: public-channel segments closed after the activation cursor are ingested for the whole Workspace, including channels with no Memory Agent. | User accepted the recommendation on 2026-10-13. |
| Q222 | Profile after removal. | A. The profile stays `openviking`. Removal changes only that group's membership. | User accepted the recommendation. |
| Q223 | Prototype gate rejects the switch. | B. The group and its Memory Agent are still created. The profile stays `off`, the rejected switch is recorded, and memory tools stay closed. | User accepted the recommendation. |
| Q224 | One shared handle versus one identity per new group. | B. Every new group shares one workspace Memory Agent and only adds that member. | User answer on 2026-10-13. Settlement was held until Q228 B explicitly superseded the per-group identity rule. |
| Q225 | Computer binding when a Memory Agent is provisioned. | A. Bind it to the provisioning user's earliest Computer in that Workspace. If that user has none, still create the member unbound, and bind it to that user's earliest Computer once one exists. Group creation does not fail. | User accepted the recommendation on 2026-10-13. Binding happens at provision time. |
| Q226 | Retry after the prototype gate later allows `openviking`. | A. Retry the recorded switch when the gate allows it, without waiting for another new group. | User accepted the recommendation. |
| Q227 | Adding a Memory Agent again after removal. | A. Add the same agent back. Its identity and session continue. Removal does not delete the agent. | User accepted the recommendation. |
| Q228 | Per-group identity versus one workspace Memory Agent. | B. Supersede per-group provision. The first new group provisions the one `@memory`. Later new groups only add that member. | User answer on 2026-10-13. Supersedes the per-group provision sentence in ADR-0016 and CONSENSUS #15. Promoted as `default-memory-agent/Q217–Q235`. |
| Q229 | Handle `memory` is already taken. | C. That new group is created without a Memory Agent. | User answer on 2026-10-13. The live agent or member username keeps `memory`. This creation does not switch the profile. |
| Q230 | The handle becomes free later. | A. The next new group provisions `@memory` and attempts the profile switch. Later new groups add that member. | User answer on 2026-10-13. |
| Q231 | Groups created while the handle was taken. | A. They do not receive the member when a later group provisions `@memory`. Someone can add that same agent afterward. | User answer on 2026-10-13. |
| Q232 | Rename after provision. | A. The renamed agent remains the one Memory Agent. Later new groups add it. No second agent is provisioned. | User answer on 2026-10-13. Q230 applies only when that agent record does not exist. |
| Q233 | Soft-delete the Memory Agent record. | A. The delete succeeds. The next new group provisions a new `@memory` when the handle is free. The new agent does not inherit the deleted row's history. | User answer on 2026-10-13. |
| Q234 | Groups that had the soft-deleted Memory Agent. | A. They do not automatically receive the new agent. Someone can add that new agent afterward. | User answer on 2026-10-13. |
| Q235 | Changing the Memory Agent to private. | A. The change is refused. The agent stays public, and later new groups continue to add it. | User answer on 2026-10-13. |

## Decisions

| ID | Decision | Formal source | Delivery consequence |
|---|---|---|---|
| D-003 | Q217–Q235. One workspace Memory Agent, with the membership, profile, rename, privacy, and soft-delete rules in the stable key. Q228 B supersedes per-group provision in ADR-0016 and CONSENSUS #15. | CONSENSUS `default-memory-agent/Q217–Q235`; CONTEXT 群 Memory Agent. | No product delivery. Implementation is F-004. |

## Rejected assumptions

- The current product already creates that agent. Channel creation adds only the members the creator selects. `#general` enrolls existing public Agents and does not create a Memory Agent. The workspace memory profile defaults to `off`.
- Existing groups are backfilled, or only `#general` is backfilled.
- The default Memory Agent cannot be removed, or it must remain and may only be muted.
- The agent is created while the profile stays `off`, or it is created only when the profile is already `openviking`.
- Old channels are excluded from ingestion, or the profile stays `off` and only the new group's segments are ingested.
- Removing a Memory Agent turns the Workspace profile `off`.
- Group creation fails when the prototype gate rejects the profile switch. For that gate, the group is still created with its Memory Agent.
- A taken `memory` handle is solved by a suffixed handle or by taking over the existing agent. Q229 C leaves that new group without a Memory Agent.
- A taken handle permanently cancels automatic provision. Q230 A provisions `@memory` on the next new group after the handle is free.
- Groups created while the handle was taken are backfilled when a later group provisions `@memory`. Q231 A leaves them without the member until someone adds that same agent.
- Renaming the provisioned Memory Agent frees the handle `memory` and causes the next new group to provision a second one. Q232 A keeps the renamed agent as the one Memory Agent.
- Soft-deleting the Memory Agent is refused, or the next new group restores the deleted row. Q233 A provisions a new identity with no inherited history.
- Groups that had a soft-deleted Memory Agent automatically receive the replacement. Q234 A leaves them without it until someone adds the new agent.
- The Memory Agent can be changed to private and still remain the sole Memory Agent, or private visibility causes a replacement provision. Q235 A refuses the change.
- Each new group provisions its own Memory Agent identity. Q228 B supersedes that sentence of ADR-0016 and CONSENSUS #15.

## Register changes

- Open questions: none. OQ-003 remains open and is outside this cycle.
- Risks: none.
- Future directions: F-004 defers product implementation until a named delivery is authorized.

## Next trigger

A change to this presence contract, or an explicit product-delivery authorization, opens a later cycle. This closed cycle is append-only.
