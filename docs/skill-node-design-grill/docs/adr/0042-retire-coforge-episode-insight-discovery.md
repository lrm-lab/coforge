# Retire Coforge Episode and Insight from Memory Discovery

**Decision key:** `memory-coforge-episode-insight-retirement/Q160-B`
**Status:** `accepted`
**Decision:** Retire Coforge Episode and Insight from new Memory discovery; retain Coforge SkillRevision as discoverable and executable
**Scope:** Typed corpus topology, use class, expansion and consumer eligibility for Coforge Episode/Insight/SkillRevision. It preserves underlying records and audit history; it does not delete the Skill Registry.

## 背景

Before this decision, the `memory_discovery` topology included three Coforge corpora:

```text
CoforgeEpisodeAdapter
CoforgeInsightAdapter
CoforgeSkillRevisionAdapter
```

Episode and Insight partly overlap with OpenViking trajectory/projection and future factual-memory responsibilities, but SkillRevision is different: it is the Agent Evolution published executable version, with revision identity, lineage, utility, quarantine, scope and execution eligibility.

Deleting all three would remove the only existing Skill Registry without a replacement. The selected boundary retires Episode and Insight only.

## 决定

Adopt:

```text
memory-coforge-episode-insight-retirement/Q160-B
```

1. `CoforgeEpisodeAdapter` and `CoforgeInsightAdapter` are removed from all **new** `memory_discovery` candidate pools and public response arrays.
2. Episode and Insight are `retired_from_memory_discovery`, not deleted. Their source records, provenance, relationship history and audit data remain retained under their native lifecycle/ACL rules.
3. New discovery allocation, corpus floors, flex seats, interleave and discovery-wide exploration do not see Episode or Insight. Their retirement does not create replacement seats, does not relax caps and does not transfer their former priority to another corpus.
4. Episode/Insight are excluded before central use-class classification. Thus they are neither `memory_candidate` nor `analogical_prior`, even if an old Insight was active/current-head.
5. Public Memory expansion removes `episodeInsight`, and Episode/Insight cannot be an expansion anchor or an expansion target. Historical existing expansion/envelope provenance remains audit-only; it does not re-expose a retired object or create a new Hint/Offer source.
6. Existing completed envelopes, Hints, dispositions, citations and outcomes remain immutable historical records. Serving a new Hint/Offer or deriving a new expansion must recheck current status and therefore rejects retired Episode/Insight.
7. `CoforgeSkillRevisionAdapter` remains in `memory_discovery`. Active/current eligible revisions remain `memory_candidate` subject to the existing ACL, scope, quarantine, cold-start, utility, exploration and served-only constraints.
8. SkillRevision remains the Agent Evolution executable registry. This decision does not remove its stable URI, revision lineage, invocation/outcome records, utility posterior, quarantine or task-side skill execution/routing.
9. A future OpenViking factual-memory adapter may replace selected Episode/Insight consumption only through a separate explicit migration/onboarding decision. It must not silently inherit their former seats, trust or historical status.

## 场景

### Historical release Episode

A historical Coforge Episode describes a blue-green release. After retirement, it remains accessible to authorized native audit/migration tooling, but a new Memory discovery query cannot return it as a candidate or prior.

### Active Insight

An Insight was previously active/current-head and could have been classified as a memory candidate. After retirement it is excluded before use-class classification; it cannot form a new Memory Hint source.

### Active SkillRevision

`deploy.rollback@rev-12` remains active and passes scope/quarantine/utility gates. It can still enter `memoryCandidateCards[]`, participate in the existing cold-start/exploration policy and be served as a Hint/Offer source if all served-only conditions hold.

### Existing historical Hint

An immutable past Hint that cited an Insight remains part of audit, disposition and outcome history. It is not erased or retroactively rewritten. However, its Insight cannot be newly served, newly expanded or newly cited as an active discovery result.

## Consequences

### Positive

- Removes duplicated Episode/Insight memory exposure without losing audit evidence;
- avoids the unsafe deletion of SkillRevision and its executable lifecycle;
- makes future factual-memory migration explicit rather than implicit;
- prevents retired objects from consuming discovery allocation or expansion paths.

### Costs

- Memory loses Episode/Insight analogical context until a future replacement corpus is explicitly onboarded;
- existing Coforge episode-insight expansion relations become audit-only for public Memory retrieval;
- adapter registry, use-class policy, allocation and expansion implementation must remove these two kinds;
- frozen historical records require status recheck at every new serving boundary.

## Implementation status

No production implementation is changed by this ADR. Implementation must remove the two typed adapters from new discovery dispatch, exclude their cards before use-class classification, remove public episode-insight expansion, preserve immutable audit history, and retain SkillRevision adapter/registry/execution behavior.
