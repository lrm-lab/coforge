# Pause Memory Agent Current-log Exact Retrieval

**Decision key:** `memory-agent-current-log-pause/Q158-A`
**Status:** `accepted`
**Decision:** Omit current-log exact from the group Memory Agent tool/schema surface; reject forged exact clauses in depth
**Scope:** The stable group Memory Agent's authority to use the `current_log_exact` lane. This is a role-scoped pause, not a deletion of the lane or a change to non-Memory roles.

## 背景

The unified retrieval contract normally permits `retrieve(SearchPlan)` to dispatch two typed lanes:

```text
query.exact present                 → current_log_exact
intentText or dependencyPattern set → memory_discovery
```

The group Memory Agent is now intentionally paused from using `current_log_exact`: the lane and `query.exact` are absent from its visible tool/schema surface. It should continue to discover historical Fork/Branch/Skill/AIG-projection experience through `memory_discovery`.

This pause does not revoke all current-context capabilities: Memory may still use its separately authorized overview/question, bounded reading, frozen graph and summary-first evidence-escalation capabilities. It only removes the exact literal/regex current-log search route from the Memory Agent profile.

A focused Pi inspection timed out without output; the required local fallback search found no executable `current_log_exact`/Memory Agent enforcement call site in the workspace. Therefore this ADR records the required fail-closed policy and explicitly does not claim that a production code switch was changed.

## 决定

Adopt:

```text
memory-agent-current-log-pause/Q158-A
```

1. The stable group Memory Agent's visible tool surface and role-projected `SearchPlan` schema omit `current_log_exact` and `query.exact`. Its retrieval input admits only `intentText` and/or `dependencyPattern`.
2. The omission is a capability boundary, not an instruction: a forged, legacy, replayed or otherwise injected Memory request containing `query.exact` is rejected at the service-side role-policy/schema boundary with a stable role-disabled validation error, for example `exact_lane_disabled_for_memory_agent`.
3. To use history retrieval, the Memory Agent submits the visible intent/dependency-only plan. That dispatches `memory_discovery` normally and leaves `current_log_exact=not_dispatched/none/not_selected` because the Memory schema cannot express an exact clause.
4. A forged mixed semantic-plus-exact request is rejected as a whole before dispatch. The service never silently removes the hidden clause and then claims that current-log verification occurred or was unavailable.
5. Q140's clause-presence dispatch rule remains unchanged for roles whose profile permits exact search. Once a permitted role supplies `query.exact`, the lane must dispatch or terminate visibly; it may not be silently skipped.
6. Reader, Critic, Refiner, Builder, Diagnosis and other authorized non-Memory roles retain their existing role-specific exact/search capabilities. This ADR does not broaden any role's authority.
7. `memory_discovery` remains available to the Memory Agent with its existing ACL, scope/snapshot, budget, candidate/prior and served-only Hint constraints.
8. The pause is versioned and auditable. Re-enabling Memory exact search requires a new explicit decision; it must not return through fallback, prompt changes, or hidden policy defaults.

## 场景

### Historical guidance only

The Memory Agent sees “切流后错误率升高” and needs historical guidance:

```text
intentText = "切流后错误率升高时如何安全回退"
exact = absent
```

The plan is valid. `memory_discovery` runs; `current_log_exact` is not dispatched because no exact clause was supplied.

### Forged or legacy mixed verification request

A malicious or legacy client tries to send a hidden exact clause alongside Memory Agent semantic input:

```text
intentText = "切流后错误率升高时如何安全回退"
exact = "5xx"
```

The request is rejected before dispatch. Normal Memory Agent tools never show this field. The system does not run history discovery and pretend that the `5xx` verification was merely unavailable.

### Reader evidence verification

A Reader with its permitted role profile submits an exact clause for `schema mismatch`. Q140 still applies: the exact lane dispatches against that Reader's scope/snapshot or terminates with an explicit reason. This ADR does not pause Reader verification.

## 后果

### Positive

- Memory cannot accidentally turn historical guidance generation into current-log fact checking;
- the pause is fail-closed and auditable rather than prompt-dependent;
- `memory_discovery` remains fully available;
- non-Memory evidence-verification roles retain their intended boundary.

### Costs

- Memory cannot independently confirm an exact current-log phrase during the pause;
- forged or legacy exact-clause injection is explicitly rejected rather than silently altering a request;
- an implementation boundary must project a Memory-specific tool/schema that omits exact before the unified retrieval facade is exposed.

## Implementation status

No production code was changed: the local source search found no executable Memory Agent/current-log exact call site to disable. The pending implementation must enforce this policy at role-profile/SearchPlan validation before lane dispatch and add tests for the three scenarios above.
