# G6：冷却按 task lineage + 正向 outcome utility 计算函数（Q89-A、评审 Minor #19）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## A 部分：投递节流按 (target_agent_id, task_lineage_id)
设计契约：冷却与未决上限按"同一 task lineage × 同一 target agent"计，而非按 target 全局计。当前 openviking/session/memory_hints.py 的节流（未决≤2、冷却 300s、同 provenance 去重）是 per-target 全局。
1. 节流状态键改为 (target_agent_id, task_lineage_id)。
2. 投递 API 增加 task_lineage_id 参数；未提供时归入字面 "*" 桶（兼容既有调用与测试）。
3. 同 provenance 去重同样按 lineage 桶。
4. 现有语义不得放宽：disposition 每 hint 一次（F2e）、defer_all/silence_all 偏好、TTL 过期仅记 exposure。

## B 部分：正向 outcome utility 计算
设计契约（Q89-A）：只有 adoption(decision=adopt) + followthrough(完成) + 正向 outcome 三者齐备才形成正向 outcome utility；四层事件目前只是分开追加，无聚合函数。
1. 新模块 openviking/session/outcome_utility.py：policy-versioned 纯函数聚合，例如
   `positive_outcome_utility(events, policy_version) -> 聚合结构`
   输入为事件 dict 列表；字段名以现有 MemoryHintStore 的 disposition/followthrough/outcome 事件与 CitationLedger 事件的落盘 schema 为准——先读这两个模块确认字段再适配，不要臆造字段名。
2. 按 hint_id（或可配置 object key）聚合：三条件齐备记一次 positive；输出 `{object_key: {positive_count, evidence_refs, policy_version}}`；三缺一不计，不得用 exposure/citation 冒充 adoption。
3. 纯函数：同输入同输出，不写盘、不取当前时间。

## 允许修改的文件
openviking/session/memory_hints.py、新文件 openviking/session/outcome_utility.py；
tests/test_memory_hints.py、新文件 tests/test_outcome_utility.py。

## 验收
新测试：A——不同 lineage 互不触发对方冷却，"*" 桶兼容旧行为；B——三缺一不计、多次正向累计、不同 policy_version 分栏。
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_memory_hints.py tests/test_outcome_utility.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件。
