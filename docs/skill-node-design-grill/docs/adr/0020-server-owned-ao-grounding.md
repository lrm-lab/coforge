# AIG 的 canonical AO grounding 由服务端唯一写入口完成

论文 `step_refs` 只是单条 raw trace 内的局部步骤坐标；OpenViking InfluenceBlock/Claim 需要稳定 AO、session、segment、watermark、content hash 与 ACL provenance。语义边界仍由 AIG Builder 自适应选择，但 Builder 不得提交或铸造 canonical `ao_id`。它只提交绑定本次 snapshot capability 的 opaque row handle、block 语义和 claim 端点。

唯一 `AoGroundingService.resolve_and_freeze` 负责在同一 pinned snapshot 内将 handle 解析为 ledger 中真实 AO，以调用角色自己的 principal 重验存在性与 ACL，校验 watermark、hash、sequence、participant、session、segment、连续性与 overlap，由服务端派生 SourceRef、InfluenceEvidenceRef 与 coverage，再运行 validator 并原子 freeze/register revision 与投影。任一对账失败整体拒绝，不修补、不部分接受；调用方可另行选择明确 fallback。所有任意构造 resolved refs 后直接 freeze 的旁路必须收口或只接受不可伪造的内部 resolved 类型。
