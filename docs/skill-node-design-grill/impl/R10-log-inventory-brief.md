# R10 派发 #1：日志完整性盘点（为「跑完分析 log 优化表现」做准备）

**用户要求**（2026-10-01）：「你先让cursor看下能不能保存尽可能完整的log，用于跑完后分析log优化表现，然后派cursor进行测试现在的卡点有哪些」——本件是**第一部分**：把「现在到底能拿到哪些 log／缺什么／不改 harness 能补什么」弄成可执行清单。**第二部分（卡点测试）等这份回来后再派**，因为卡点测试要按这份结论把采集做进去。

## 0. 硬约束（违反即交回重做）

- **只读**：`evol_bench/`、`memory_graph_evolving/` 两个仓**只读**，唯一允许写的是报告文件 `/home/zhoujie22/river2_0/skill-node-design-grill/impl/R10-log-inventory.md`。**不 push、不建 `ov.conf`、不加依赖。**
- **不许动**暂停中的 eval 栈：端口 `18888／1933／8789／8732／8733`、`coforge-openviking-prototype-1`、共享 `coforge` DB。**不要启动／重启／停止任何服务**（本件是盘点，不是跑批）。
- 凭据只从环境文件进，**不进 argv**；不要打印任何密钥内容。
- 报告里**每条结论都要给出处**：`file:line`，或「在某份已录制产物里实测看到（给出路径与字段名）」。**必须把「实测看到」与「从代码推断」分开标**。

## 1. 要回答的问题

**（A）逐层盘点：现在每跑一集，实际落盘了什么？** 至少覆盖这五层，逐层给字段级清单：

1. **bench-runner**：`attempts.jsonl` 全部字段（含哪些是空的／没填的）；`work-<arm>/` 下的每个文件与目录（`episodes/<seq>-*/` 里的 `*.jsonl`（pi 会话）、`sb-actions.jsonl`、`host-events.jsonl`、`pi-stderr.log`、`sb-task.json`、`consolidated-*.md`…），逐个说明是什么、粒度多细、有没有截断。
2. **pi 侧 agent transcript**：`work-<arm>/episodes/<seq>-*/<ts>_*.jsonl` 里**到底记了什么**——每轮的 role／content 是不是**全文**？工具调用的**完整入参与完整输出**在不在？每轮的 `usage`（input／output／cacheRead…）在不在？时间戳／耗时在不在？**「最终送给模型的提示全文」（尤其其中的 recall 段）能不能从 transcript 里还原出来？**
3. **sidecar（容器工具面）**：`--log` 的 lifecycle 记录有哪些 kind（`exec`／`verdict`／…），每条记什么；`exec` 的命令与**输出**记不记、截不截断；`/verdicts`、`/verify` 的判分细节（`reward.txt` 原文、`verifier_exit`、stdout／stderr）落在哪。
4. **容器内**：官方 `verifier/test.sh` 的 stdout／stderr、`reward.txt`、agent 在容器里产生的文件，跑完还剩不剩、在哪（`docker logs`？挂载目录？）、**要不要显式抓**。
5. **memory plane（GMS／将来的适配层）**：每轮 recall 的**请求全文与返回全文**现在记在哪（GMS 的 state.json？日志？）——**这一条是本次盘点的重点**：跑完要靠它分析「召回了什么导致 agent 怎么做」。

**（B）缺口**：为了「跑完能分析 log 来优化表现」，哪些量**现在拿不到或拿不全**？逐条写：缺什么、为什么重要（用来优化什么）、现在最接近的替代品是什么。

**（C）不改 harness 能补到什么程度**：给出**操作侧**采集方案（不许改 Go 侧、不许改 sidecar 代码），至少评估这几条并给结论：
- 我们的 **memory plane 适配层自己全量记**（请求／返回／耗时／引用）——这是必然能做的一条，写清记什么字段；
- 包一层 **`tee`／wrapper** 抓 bench-runner 的 stdout／stderr（有没有现成的？记什么？）；
- 每集跑完抓 **`docker logs`／容器文件**（给具体命令，说明对哪些容器名生效）；
- pi transcript 是**已经够全**，还是需要额外开关（查 pi 的 CLI 有没有 verbose／log 级别参数，给出参数名与出处）；
- **磁盘代价**：按已录制轮次的实测体积（如 train 轮 14 集 / 4.2 MB）外推，全量 45 任务 × 双臂需要多少（分「只留结构化记录」与「连原始 stdout 一起留」两档）。

**（D）一份可直接照做的采集清单**：跑批**之前**要设什么（环境变量／目录／命令）、**每集跑完**抓什么、**跑完整轮**汇总什么（给命令），以及「哪些是必须、哪些是可选」。

## 2. 已录制的产物（拿它们做实测依据，别只读代码）

在 `evol_bench/SkillsBench/results/` 下：`sb-smoke-local-1`、`sb-smoke-par-1`、`sb-smoke-gmsgb-dsv4flash-1`、**`sb-train-wsb-dsv4flash-r1`（14 集、最全，主依据）**。GMS 侧状态在 `results/<轮>/gms-<arm>/state.json`。

## 3. 交回

1. 报告 `impl/R10-log-inventory.md`（按 A／B／C／D 四节）；
2. 终端里**不超过 20 行**的摘要：现在最全能拿到什么、缺的三条最重要的量、不改 harness 的补法一句话；
3. 明确说**哪些结论是实测、哪些是推断**，以及**哪些问题你没能回答**（不许用猜测填空）。
