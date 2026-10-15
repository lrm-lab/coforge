# Cycle 002 — Memory Disposition Receipt

**Status:** `closed`
**Opened:** 2026-10-13
**Closed:** 2026-10-13
**Extends:** cycle 001; CONSENSUS #53 and #56; Q89-A
**Formal sources updated:** [CONSENSUS.md](../CONSENSUS.md) `memory-disposition-receipt/Q190–Q216`；[CONTEXT.md](../CONTEXT.md) 的 Memory Hint 与 Memory disposition。未新建设计 ADR：CoForge 仓库规则禁止新增 ADR。

## Scope

Decide how the agent named by a Memory Hint learns and submits `adopt | reject | defer`. This cycle extends the Q89-A output contract. It does not reopen retrieval, Hint grounding, followthrough, outcome utility, or delivery throttling, and it does not authorize product implementation.

## Frontier and answers

| ID | Decision | Answer | Evidence or rationale |
|---|---|---|---|
| Q190 | How the disposition duty enters the named agent's context, and which act counts as the receipt. | C. A dedicated disposition tool. The Hint message names `hint_id` and the tool name. Only that tool call is a receipt. | User answer on 2026-10-13. Q89-A already requires a structured `MemoryDisposition` and rejects both a natural-language claim and server-side inference. |
| Q191 | Call surface. | A. A native tool on the target agent. The tool schema shows `adopt \| reject \| defer`. That call is the receipt. | User accepted the recommendation on 2026-10-13. |
| Q192 | Whose call counts. | A. Only the authenticated target of that `hint_id`. Other callers are rejected and create no disposition. | User accepted the recommendation. Q89-A gives the named agent the adoption decision. |
| Q193 | Field authority. | A. The model submits `hint_id`, `decision`, `reason`, and optional `intended_action_refs`. The server writes `target_agent_id` from the caller and `decided_at` from its clock. | User accepted the recommendation. Q119 allows two pending hints, so the server cannot infer `hint_id`. |
| Q194 | A second call on the same hint. | C. `defer` may be replaced by one later `adopt` or `reject`. `adopt` and `reject` are terminal. Repeating the current terminal decision returns the original record. | User accepted the recommendation. Followthrough and outcome still do not rewrite a terminal decision. |
| Q195 | Order relative to the target's current work. | C. The tool description tells the target to call before applying that hint. The server does not freeze other tools. Actions before a successful `adopt` are not followthrough. | User accepted the recommendation. |
| Q196 | `defer-all`, type filters, and user silence. | A. These suppress delivery. No hint is sent, no tool call is required, and no exposure or disposition is recorded for the suppressed item. | User accepted the recommendation. A suppressed item never enters the target's visible context. |
| Q197 | Window for replacing `defer`. | A. `defer` leaves the pending slot. One later `adopt` or `reject` is accepted until the hint's existing delivery TTL. Another `defer` returns the original and does not refresh TTL. After TTL the `defer` stands, with no added exposure. | User accepted the recommendation on 2026-10-13. The TTL duration remains OQ-003. |
| Q198 | Native tool name. | A. `memory_disposition`. | User accepted the recommendation. |
| Q199 | Where the tool is listed. | A. Every task agent has it in its standing tool list. The Memory Agent fence does not. Calls rejected by Q192 write no disposition. | User accepted the recommendation. |
| Q200 | How the Hint message names `hint_id` and the tool. | A. Structured fields on the recipient's delivery. The channel body remains the Hint content. | User accepted the recommendation. |
| Q201 | Failure detail. | C. Non-targets receive one opaque failure. The legitimate target can distinguish not found, expired, and already terminal. | User accepted the recommendation. |
| Q202 | `intended_action_refs`. | A. Optional intent. The server stores it without checking that the actions have occurred, and it is not followthrough evidence. | User accepted the recommendation. |
| Q203 | Channel side effect. | A. The tool only records the disposition. It does not post a channel message. A later channel reply is not a receipt. | User accepted the recommendation. |
| Q204 | Citation role derived from a disposition. | A. `adopt` and `defer` write `considered`. `reject` writes `rejected`. `applied` is written only by later followthrough. Replacement appends a new citation and does not delete the earlier one. | User accepted the recommendation. Q89 defines `applied` plus action matching as adoption evidence. |
| Q205 | Whose delivery creates exposure. | A. One exposure for the named target when the hint is delivered to that target. Other members reading the channel body do not create exposure. | User accepted the recommendation on 2026-10-13. |
| Q206 | Empty `reason`. | A. For the legitimate target, an empty or whitespace-only reason is an invalid argument and writes nothing. It is distinct from not found, expired, and terminal. A non-target receives the Q201 opaque failure. | User accepted the recommendation. |
| Q207 | Concurrent calls for one hint. | A. The server serializes calls per `hint_id`. The first committed call takes effect under Q194 and Q197. A later call is judged against that state. | User accepted the recommendation. |
| Q208 | Citation granularity. | A. One citation per source included in the hint, each with the Q204 role and linked by `hint_id`. The model cannot omit a source. | User accepted the recommendation. |
| Q209 | Memory Offer as the Hint delivery. | A. A Memory Offer that delivers a Memory Hint is the Q200 delivery. Its body is the Hint content, and its structured fields carry `hint_id` and `memory_disposition`. The tool is the only receipt. This cycle does not change product code. | User accepted the recommendation. |
| Q210 | Disposition history when `defer` is replaced. | A. The replacement appends a disposition event. The `defer` event remains. The latest accepted decision is the current adoption intent. Citations append under Q204. | User accepted the recommendation. |
| Q211 | Source ACL after delivery. | A. Every call that would write a new disposition rechecks the caller's current ACL against the hint's frozen sources. Unreadable sources are omitted from the new citations and reported to the legitimate target. If none remain readable, nothing is written and the target receives a distinct not-actionable failure. Discovery eligibility, retirement, and quarantine are not re-applied. Non-targets still receive the Q201 opaque failure. | User accepted the recommendation on 2026-10-13. |
| Q212 | Target leaves the channel after delivery. | A. Leaving does not cancel disposition rights. The target may call within the delivery TTL under Q194 and Q197. Channel membership is checked at delivery only. | User accepted the recommendation. |
| Q213 | Failure for an unknown `hint_id`. | A. A caller who is not the target of a live hint receives one opaque failure. Unknown ids and another agent's hints share that failure. The target receives expired, terminal, invalid-argument, or not-actionable only for a live hint that names them. A mistyped id receives the same opaque failure. | User accepted the recommendation on 2026-10-13. This preserves Q201's requirement that failure text not reveal whether a hint exists. |
| Q214 | Empty reason together with unreadable sources. | A. Return invalid-argument, do not inspect source readability, write nothing, and do not consume the `defer` replacement. The response does not describe source access. | User accepted the recommendation. |
| Q215 | Incomplete call shape. | A. A missing `hint_id`, a missing `decision`, or a `decision` outside `adopt \| reject \| defer` is invalid-argument for every caller and writes nothing. This failure does not indicate whether a hint exists. A well-formed call by someone who is not the target of a live hint remains the Q213 opaque failure. Empty reason is still checked only after the caller is known to be the target. | User accepted the recommendation on 2026-10-13. |
| Q216 | Not-actionable result when every frozen source is unreadable. | A. Return not-actionable and list the unreadable source refs, without source content and without a channel message. | User accepted the recommendation. |

## Decisions

| ID | Decision | Formal source | Delivery consequence |
|---|---|---|---|
| D-002 | Q190–Q216: `memory_disposition` is the only Memory Hint receipt. | CONSENSUS `memory-disposition-receipt/Q190–Q216`；CONTEXT 的 Memory Hint 与 Memory disposition | No product delivery. Q165-A stays closed. |

## Rejected assumptions

- A standing instruction, by itself, tells the named agent to emit `adopt | reject | defer`.
- An explanation of the three decisions written into the Hint message is itself the receipt.
- The current `@mention` on a Memory Offer already supplies this duty. The product offer is a normal channel message, and the task-agent instructions do not mention the disposition.
- A `coforge` subcommand, or both a subcommand and a native tool, can satisfy the receipt.
- Any channel member who can read the hint may decide, or the model may name the deciding agent.
- The first call is always immutable, or any later call supersedes a terminal decision.
- The server freezes the target's other tools until disposition.
- `defer-all`, a type filter, or user silence still delivers a hint or writes a disposition without the tool.
- Replacing `defer` is unbounded, or must happen in the same agent turn.
- The tool is named `hint_disposition`, or its name is left to implementation.
- The tool is injected only while a hint is pending, or only after an agent opts in.
- `hint_id` and the tool name are written into the channel body.
- Every caller receives the same failure detail, or every caller receives a distinct reason.
- `intended_action_refs` must already have occurred, or the field is removed from the tool.
- A successful disposition posts the decision into the channel.
- `adopt` immediately writes citation role `applied`.
- Every agent who reads the channel body receives exposure, or the Hint body is hidden from other members.
- An empty reason is stored or replaced with a server default.
- Concurrent calls all write, or all fail with nothing written.
- One citation represents the whole hint, or the model chooses which sources to cite.
- The existing Memory Offer stays outside this receipt, or Memory Offer is removed.
- Replacing `defer` overwrites that event or deletes its citation.
- Disposition rechecks whether the hint's sources would still be served, retired, or quarantined.
- An ACL failure on one source invalidates the whole hint.
- Leaving the channel expires the hint, or disposition rights return only after rejoining.
- An unknown `hint_id` returns a distinct not-found error, or that distinct error is reserved for one task agent.
- An empty reason and an ACL failure are reported together, or the ACL failure is reported first.
- A missing `hint_id` uses the same failure as an unknown id, or every malformed call uses the opaque failure.
- The not-actionable result is only a code, or it posts the unreadable source refs to the channel.

## Register changes

- Open questions: OQ-003 remains open. This cycle does not choose Hint delivery TTL or cooldown defaults.
- Risks: none.
- Future directions: F-003 defers product implementation until a named delivery is authorized.

## Next trigger

A change to this receipt contract, an explicit product-delivery authorization, or a request to set the OQ-003 durations opens a later cycle. This closed cycle is append-only.
