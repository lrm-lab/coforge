# Round 7 答复（设计者，中间人整理）

- **Q37–Q43：全部按推荐确认**。设计者在 Round 7 问题呈现后未提异议，并在下一轮增补讨论中直接以"相似的 context 会有边连接"为前提继续细化（即接受 Q40/Q41 的边与簇模型）；Round 8 派发简报中已记录"设计者已全部按推荐确认"，此后两轮机会均未推翻，正式生效。
- 要点：评估编排以 fork revision 权威提交为触发点；候选 ≤5/run、浅层草稿、未成 fork 留 provenance；相似判定四维 + 四值 verdict + 负样本仅离线；**中心式可重叠簇**（相似性不传递、merge/split 走 successor）；簇维护复用 propose→验证→原子提交；**簇条件效用** + 已验证簇内正向分支模式生成 proposal；draft 直查 branch、有界 walk_path、未验证想象不进跨树检索。
