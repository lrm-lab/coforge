# Diagnostic Subgraph Typed Retrieval Text

**Decision key:** `diagnostic-subgraph-text/Q157-B`
**Status:** `accepted`
**Decision:** Add restricted typed structural tokens to diagnostic-subgraph retrieval text; retain BM25-only ranking
**Source record:** Pi focused analysis of `OpenViking/openviking/session/retrieval_facade.py`
**Scope:** Diagnostic historical-subgraph document/query representation in OpenViking; does not add a vector path, structural scorer, global reranker, or alter Q156 per-corpus memory-discovery fusion.

## 背景

`OpenViking/openviking/session/retrieval_facade.py` currently declares:

```text
SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"
DIAGNOSTIC_SUBGRAPH_HIT_CAP = 3
```

`_subgraph_retrieval_text()` is shared by the diagnostic query subgraph and each historical document subgraph. It currently concatenates only prose fields:

```text
block: summary, input, output
claim: carried_artifact, downstream_effect
```

The historical-subgraph path calls `_rank_document_indexes()` in BM25-only mode. Non-positive BM25 hits are omitted, no zero-score result backfills the three-hit cap, and equal scores preserve candidate storage order. There is no vector or hybrid ranking on this path.

The text representation currently excludes role, block kind, relation type (including skip), failure markers, provenance/evidence refs, AO ranges, object IDs, guidance and raw AO. Consequently, two prose-similar subgraphs with materially different failure/graph structure cannot be distinguished by the diagnostic retrieval text.

Example:

```text
A: deploy → cutover → error-rate rise
   relation=influence, failure=true

B: deploy → announcement → error-rate rise
   relation=skip, failure=false
```

When their prose overlaps, the prior representation gives BM25 no structural signal to prefer A for a cutover-failure query. Conversely, implementation evidence shows that some typed fields may be frequently constant or absent (for example fallback block kind may be `unknown`), so a rich learned or structural score is not presently justified.

## 不重开的约束

1. Diagnostic retrieval remains an independent BM25-only path; it does not use Q156 memory-discovery hybrid fusion, vector retrieval, RRF or a cross-corpus score.
2. The query must remain a failure-marked subgraph; historical candidates retain existing purpose, ACL and fork-grounding constraints.
3. Typed text must never include raw AO, guidance, user/channel message content, source/evidence refs, AO sequence ranges, opaque IDs, ACL labels or hidden candidate information.
4. This decision changes representation, not candidate eligibility, top-3 cap, zero-score policy, superseded-revision corpus policy, or equal-score storage-order behavior.
5. Typed tokens are one versioned lexical representation shared identically by query and document construction; no caller supplies free-form structural filters.

## 备选方案

### Option A：Prose-only BM25

Keep the existing prose fields and document its structural blind spot.

This has no migration or hash churn, but permanently leaves role, relation, failure and block-kind differences invisible to lexical retrieval. Empty text remains storage-order selection.

### Option B：Restricted typed lexical tokens

Retain BM25 as the sole ranker, while appending a bounded canonical typed-token section derived from already-visible subgraph metadata.

The representation includes only:

```text
subgraph_failure:<true|false>
block_role:<normalized-role|unknown>
block_kind:<normalized-kind|unknown>
block_failure:<true|false|unknown>
claim_relation:<normalized-relation|unknown>
claim_failure:<true|false|unknown>
relation_profile:<canonical-count-summary>
```

`relation_profile` is an aggregate of relation types present in the subgraph, including `skip`; it is canonicalized by token name and has bounded counts. Missing/unsupported data emits the explicit `unknown` value rather than silently altering the text shape. Token names, value normalization, field ordering and the policy version are deterministic. Existing member order and existing prose-field order remain unchanged; the typed section is appended after prose.

### Option C：Separate structural/vector scoring layer

Keep prose unchanged and add a structural-signature scorer and/or embedding model, fused with or replacing BM25.

This could capture semantic and structural similarity beyond lexical tokens, but requires a new policy for feature weights, fusion, missing data, model/index availability, fallback, audit, calibration and ranking tests. It is not a text-policy-only change.

## 决定

Adopt **Option B**:

```text
diagnostic-subgraph-text/Q157-B
```

The accepted contract:

1. Bump `SUBGRAPH_TEXT_POLICY_VERSION` from its pending value to a versioned accepted typed-text policy.
2. `_subgraph_retrieval_text()` produces the existing ordered prose first, then a bounded canonical typed-token section.
3. The token allowlist is exactly subgraph failure status, block role, block kind, block failure marker, claim relation type, claim failure marker and canonical aggregate relation profile. No other metadata joins the retrieval text without a new decision.
4. Values are canonicalized and explicit `unknown` tokens preserve deterministic representation when metadata is absent; IDs, raw evidence, provenance, ACL/security metadata, guidance and AO ranges remain excluded.
5. Query and historical document construction use the same policy and version; a representation content hash/test fixture must change together with the policy version.
6. Ranking remains BM25-only with current positive-score admission, top-3 cap and existing tie behavior. This ADR does not promise semantic zero-overlap recall.
7. Typed-token occurrence is lexical evidence only; it is not proof that a historical causal mechanism is applicable, nor evidence supporting a current AIG Claim.
8. Policy/version, normalization and text-representation hash are auditable. Public diagnostic results do not expose raw token internals, hidden candidate counts or ACL-filtered structure.

## 场景

### Same prose, different edge semantics

Both historical subgraphs say “deploy, switch traffic, inspect errors.” One has `claim_relation:influence` and `subgraph_failure:true`; the other has `claim_relation:skip` and `subgraph_failure:false`.

Under the accepted policy, a failure/influence query shares lexical typed tokens with the first history, while the second no longer ties solely through prose.

### Fallback view with unknown kind

A fallback view does not populate block kind. It emits `block_kind:unknown`, rather than omitting the field. This prevents representation length and field presence from becoming accidental, storage-dependent ranking signals.

### Semantic zero lexical overlap

“切流后错误率升高” and “切换新集群后 5xx 上升” may still share neither prose nor typed token enough to produce positive BM25. B improves structural lexical discrimination but does not claim to solve semantic recall; a future structural/vector scorer would require a separate decision.

## 拒绝其他方案

Reject A because the existing representation unnecessarily erases stable, non-sensitive structural facts that are already present in the diagnostic subgraph.

Reject C because it is a distinct ranking-policy program with incomplete evidence about feature coverage, weights, vector service behavior and fallback governance. Its complexity is not justified to solve the present representation omission.

## Audit and consequences

The audit/test fixture records at least:

```text
subgraphTextPolicyVersion
normalizedTokenSchemaVersion
representationContentHash
proseFieldOrderVersion
typedTokenOrderVersion
```

Positive consequences: diagnostic BM25 can distinguish selected failure and graph-structure differences without exposing raw evidence or adding model dependencies.

Costs: text hashes and BM25 rankings change; sparse/constant typed fields may provide limited lift; this does not fix zero-lexical-overlap semantic recall, tie-order behavior, candidate failure filtering or superseded-revision duplication.

## Frontier

Q157 closes the last known pending policy seam from the Q155 frontier scan. The design tree must now be re-scanned for any remaining independently unblocked user decisions before claiming shared understanding; implementation does not begin automatically.
