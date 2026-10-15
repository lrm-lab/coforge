# commit 时只建全覆盖 AO 台账，fork node 由诊断 agent 按需构造

最初设计（及前几轮默认）是 commit 时随 Working Memory 抽取"关键步骤"并设数量上限。设计者在 Round 4 转向：commit 只建立**全覆盖、廉价的 action-observation 台账**（observation 走确定性 synopsis，条目强制记录 skill_invocations）；fork node 由诊断 agent 分页读台账（可下钻原文）、在问题点/可改进点处**按需构造**，稀疏性来自需求而非预算，故不设每 archive 数量上限。原"关键步骤资格判定"降级为选点启发式，ov_wm_v2 的 Working Memory 语义保持不变。

## Consequences

- ao_id 必须在运行时发号且全局唯一、永久不变，commit 只追加归属——否则跨 commit 引用与按需构造都不可靠。
- fork node 的 used_skills[] 只能从台账机械回填，事后不可推断补齐。
