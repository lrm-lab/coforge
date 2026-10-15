任务：修正 session_state 锚点的稳定身份语义（切片 S5b，仲裁裁定落地）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation；S5 已提交：openviking/session/causal_experiences.py）

裁定（kiro 仲裁，必须照做）：
1. session_state 锚点的 canonical_anchor_key **只含 {anchor_kind, session_id}**——ledger_snapshot_watermark、live_ao_upper_bound、anchored_at 属于某次 revision 冻结的证据视图，不属于 subject 身份。同一 session 的两次"当前状态"诊断必须复用同一 fork_node_id、以 revision 递进（表达 supersedes 关系），不得分裂为新节点。
2. revision 权威顺序：以显式 supersedes_revision_id 链为准；无法成链的并发 sibling revision 按 created_at 排序（再以 revision_id 作稳定平局），且**不得推断互相 supersede**。

改动要求：
1. causal_experiences.py 中 canonical_anchor_key 的 session_state 分支改为只序列化 anchor_kind + session_id（ao 与 interaction_edge 分支不变）。anchor 载荷本身仍保留全部冻结字段。
2. get_fork_node 返回的 revisions 列表按上述权威顺序排序（先按 supersedes 链首尾相接排，孤儿 sibling 按 created_at、revision_id）；latest_revision 为链尾（无链时取排序最后）。
3. 新增/修改测试（tests/test_causal_experiences.py）：
   - 同 session 两个不同 watermark 的 session_state 诊断 → 同一 fork_node_id、两个 revision、后者可带 supersedes_revision_id=前者。
   - 两个互不 supersedes 的 sibling revision → 排序按 created_at，且不推断 supersede。
   - 既有全部测试保持绿。

验收（结尾报告）：
1. `python3 -m pytest tests/test_causal_experiences.py -q` 全绿（含新增）。
2. `git diff --stat` 仅 causal_experiences.py 与测试文件。
3. 报告改动行数与排序实现要点。
