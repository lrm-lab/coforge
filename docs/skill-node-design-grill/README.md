# Skill Node Design Grill

This directory is a design engagement archive for the Fork/AIG work. It preserves the historical grill material while adding a compact traceability layer for future design and delivery cycles.

## Archived state

- Current index: [state.md](state.md)
- Formal design sources in this archive: [CONSENSUS.md](CONSENSUS.md), [CONTEXT.md](CONTEXT.md), and [ADR-0043](docs/adr/0043-aig-native-fork-overlay-and-guided-remediation.md). Memory Hint receipts follow CONSENSUS `memory-disposition-receipt/Q190–Q216`. The default Memory Agent follows CONSENSUS `default-memory-agent/Q217–Q235`.
- Current implementation gate in the archived design: Q165-A remains closed; a plan or historical test is not delivery authorization.
- Current delivery: [`DLV-001`](implementation/traceability.md) records the documentation-traceability setup only. No product implementation delivery is registered.

## Navigate

| Area | Covers |
|---|---|
| [cycles/](cycles/001-traceability-bootstrap.md) | Append-only grill cycles: frontier, answers, decisions, and closure. |
| [implementation/](implementation/traceability.md) | Decision-to-delivery evidence: branch, worktree, SHA, status, and validation. |
| [operations/](operations/worktrees.md) | Registered branch and worktree lifecycle. |
| [registers/](registers/open-questions.md) | Live open questions, risks, and deferred directions. |
| [impl/](impl/) | Historical implementation plans, verification evidence, tickets, and handoffs. |
| [eval/](eval/) | Historical evaluation plans and evidence. |
| [round-*-*.md](round-29-questions.md) | Source questions, answers, briefs, and raw records from prior grills. |

## Record discipline

The traceability layer is operational evidence, not a replacement for formal requirements. A confirmed term, contract, or irreversible decision belongs in the host repository's authoritative source; each cycle links to it. Closed cycle records preserve what was decided at the time. `state.md` is the only mutable convenience index.

Use the project-local `grill-with-traceability` skill for future cycles.

## 历史工具审查

[2026-10-14 main 审查](review/main-branches-20261014.md)、[四角色分支审查](review/role-tools-20261014.md)和[cycle 004](cycles/004-role-tool-review.md)仅描述各自记录的 SHA，不代表当前 main 的能力。
审查工作区与当前状态不同的五份原始文档以原始字节的 `.md.txt.gz` 保存在 `review/source-snapshot-20261014/`，当前 engagement 状态保留原 main 工作目录版本。

归档状态和实施门禁描述的是记录时的设计，不限制用户之后明确授权的实现。历史补丁 `eval/uncommitted-coforge-lsk.patch.gz` 保留原始字节；压缩仅用于避免修改其中的原始 diff 空白。
