# R7a 续跑 brief：上一轮 agent 被网络中断打断，请把这一波跑完并提交

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`（HEAD 仍是 `60bed6d6e`，未 push）。**追加新提交；不 rebase／amend；不 push；不引新依赖；不创建 `ov.conf`；零 LLM。**

## 上一轮的情况（不要重做已完成的部分）

上一轮你已经把 R7a 的代码改动写进工作区（`benchmark/causal_memory/l1_locomo_ranked_arm.py`，`+352/-22`，未提交），并且已经跑到**第 9 个会话 conv-49**。然后 cursor CLI 连接中断：

```
Connection lost, reconnecting ... (attempt 2)...
RetriableError: Agent turn stopped after repeated resume attempts made no progress
```

进程被杀时全量跑分在 conv-49 之后没有输出，**conv-50 没跑，最后的汇总表和 R6e 漂移门检都没打印，也没有提交**。工作区的代码改动完好、能编译（我已用 `python -m py_compile` 验过）。

所以：**不要再改设计、不要再扩指标**。代码按你上一轮写的原样保留（如果你自己发现上一轮的实现有 bug，可以修，但要在报告里说明修了什么）。

## 这一轮只剩三件事

1. **重跑全量**（10 个会话，`--limit-convs` 为 0）：
   ```bash
   /home/zhoujie22/river2_0/OpenViking/.venv/bin/python -u \
     benchmark/causal_memory/l1_locomo_ranked_arm.py \
     --data /home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json \
     --out /tmp/l1-locomo-ranked-arm-r7a.json
   ```
   用 `nohup` ＋ 日志重定向后台跑，或者前台跑都行；**关键是跑完（退出码 0）再往下**。若中途再断网，请自行重试到跑完为止。

2. **确认门检真的过了**（脚本自己会打印，任一条不符就会非零退出）：
   - R6e any-hit 漂移门检：`P_legacy 0.0%/0.0%/空并集 100.0%`、`T 56.0%@5 / 61.8%@10`、`A12 ranked @10 = 59.0%（1170）`、`A4 ranked @10 = 56.0%（1110）`、`B4 ranked @10 = 53.6%（1062）`、`B12 ranked @10 = 55.9%（1108）`、legacy `A4 36.4%（722）／A12 15.2%（302）／B4 36.4%（722）／B12 15.8%（314）`。
   - 每题一致性（`gold_n`、`coverage@k`、`all_gold@k`、`mrr` 互相自洽）零问题。
   - 旧的其它门检全过（卡片带 bm25 分、atom ao_id 在台账内、投影卡覆盖到 dia、排序无重复 dia、四条实臂 ranked 空并集非 100%）。

3. **提交并写报告**。提交信息沿用本仓风格，例如 `bench(causal-memory): non-saturated L1 metrics on LoCoMo (zero-LLM)`。`git show --name-only` 里**应当只有 `benchmark/causal_memory/l1_locomo_ranked_arm.py` 一个文件**。

## 报告要写（这是最终报告，我会照它独立复核）

- `git show --name-only` 输出；`l1_locomo_hitk.py` 与 `l1_locomo_projection_arm.py` 相对 HEAD 的 diff 字节数（应为 0）。
- **总表**：臂 × 口径 × {any-hit@5/@10、coverage@5/@10、all_gold@5/@10、mrr}（coverage 与 mrr 是均值，any-hit 与 all-gold 是题率）。
- **按 gold 条数分组**（1 条／2 条／≥3 条）的 `all_gold@10` 与 `coverage@10`——这是本波的核心表。
- 按 category 的 `all_gold@10`。
- 一句话回答：**在新指标下 atom 通道与 T 的差距是多少？投影通道与 atom 的差距是多少？R6e 的结论（atom 贴近 T、投影低 2–3 个百分点）在新指标下是否仍成立？**
- 你自行选定的地方（mrr 平局处理、gold 条数分组边界）＋ 完整运行命令 ＋ 全量耗时 ＋ 退出码。

不要在报告里写「跑分已结束」而不给数字：上一轮就是死在这里，我这边只拿到半份日志。
