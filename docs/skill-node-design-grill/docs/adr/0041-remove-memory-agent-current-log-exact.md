# Remove Current-log Exact from the Memory Agent Contract

**Decision key:** `memory-agent-exact-removal/Q159-A`
**Status:** `accepted`
**Decision:** Permanently remove the exact lane from the group Memory Agent contract; retain it for authorized non-Memory roles
**Supersedes:** `memory-agent-current-log-pause/Q158-A` (ADR-0040) for the group Memory Agent
**Scope:** Role-local removal of `current_log_exact` and every associated exact-lane concern from the stable group Memory Agent's visible request, response, budget, deadline, cancellation and audit contract. It does not remove the global lane from Reader, Critic, Refiner, Builder, Diagnosis or other authorized roles.

## 背景

Q158-A first hid `current_log_exact` and `query.exact` from the Memory Agent tool/schema while retaining a role-disabled rejection for injected requests. The user has now chosen A: the capability is not merely paused; it is deleted from the Memory Agent contract, and the exact-related questions are reset to zero for that role.

The system retains the global two-lane retrieval design for roles that need to verify current evidence. The group Memory Agent instead has one historical-experience retrieval path. This avoids presenting zero-valued exact state, quotas, deadlines or audits to a role that can never legitimately use them.

## 决定

Adopt:

```text
memory-agent-exact-removal/Q159-A
```

For the stable group Memory Agent only:

```text
visible request contract
  = MemoryDiscoveryPlan
  = intentText? + dependencyPattern?
  ≠ SearchPlan.query.exact

visible response contract
  = memoryCandidateCards[]
  + analogicalPriorCards[]
  + memoryDiscovery LaneAudit
  ≠ currentEvidenceRefs[]
  ≠ current_log_exact LaneAudit
```

1. `current_log_exact`, `query.exact`, literal syntax, regex syntax, exact fields, exact hit limits and `CurrentEvidenceRef` are removed from the Memory Agent's visible tool/API schema and prompt vocabulary.
2. A valid Memory retrieval has at least one semantic input (`intentText` or `dependencyPattern`) and dispatches `memory_discovery` only.
3. A Memory response does not contain an exact array or an exact lane audit. This is removal, not `not_dispatched`; the role has no exact lane in its contract.
4. The Memory role has no exact child budget lease, exact child deadline, exact child cancellation branch, exact quota, exact truncation, regex policy, exact audit or exact partial-completeness state.
5. Any forged, legacy or replayed payload containing an exact field is rejected before dispatch with stable `exact_capability_absent_for_memory_agent`. It cannot be silently stripped, transformed or partially executed.
6. `memory_discovery` remains subject to its own ACL, scope/snapshot, budget, deadline, cancellation, use-class, allocation, interleave, completeness and served-only Hint/Offer contracts.
7. Q134–Q146 remain active as the global multi-role retrieval design, but their Memory-exact branches are `N/A`:

```text
Q134 two-lane public shape       → Memory sees discovery-only shape
Q139 exact LaneAudit             → absent from Memory response
Q140 exact dispatch trigger      → N/A to Memory; no exact schema field
Q141 exact hit limit             → N/A to Memory
Q142 exact/discovery quotas      → Memory has discovery quota only
Q143 exact child budget          → N/A to Memory
Q144 exact child deadline        → N/A to Memory
Q145 exact cancel child          → N/A to Memory
Q146 exact partial completeness  → N/A to Memory
```

8. The non-Memory contract is unchanged. An authorized Reader, Critic, Refiner, Builder or Diagnosis role can still expose `query.exact`; Q140 then dispatches the global exact lane and Q139–Q146 apply normally.
9. Restoring an exact lane to the Memory Agent requires a new explicit ADR. No fallback, prompt, API compatibility shim or policy default may recreate it.

## 场景

### Memory historical guidance

```text
MemoryDiscoveryPlan:
  intentText = "切流后错误率升高时如何安全回退"
```

The Memory Agent sees only historical discovery cards and its discovery audit. It has no `exact` parameter, no current evidence result slot and no exact status to interpret.

### Forged legacy request

A legacy client sends:

```text
intentText = "切流后错误率升高时如何安全回退"
exact = "5xx"
```

The service rejects it before dispatch with `exact_capability_absent_for_memory_agent`. It does not execute discovery and then claim that exact verification was unavailable.

### Reader current-evidence verification

A Reader's role-specific plan includes:

```text
exact = "schema mismatch"
```

That role still receives the global two-lane contract as applicable. Q140–Q146 remain unchanged for it.

## Consequences

### Positive

- Memory Agent cannot observe, reason about or accidentally re-enable any exact-lane mechanism;
- exact-related questions have zero runtime surface for Memory rather than a dormant/disabled state;
- Memory response and control plane are smaller and less ambiguous;
- historical discovery remains available;
- current-evidence verification remains available to roles designed for it.

### Costs

- Memory cannot consume current exact evidence or describe an exact-lane completion state;
- client/tool projection and envelope projection must be role-aware when implemented;
- legacy payloads fail rather than receiving compatibility behavior.

## Implementation status

No production code was changed. Current source does not expose an executable Memory Agent/current-log exact call site. Future unified retrieval implementation must provide a distinct MemoryDiscoveryPlan and discovery-only envelope projection, plus reject exact-bearing payloads before all lane dispatch, lease issuance and audit construction.
