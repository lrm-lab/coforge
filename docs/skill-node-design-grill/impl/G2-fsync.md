# G2：citation ledger 追加 fsync（评审 Minor #18）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景
CitationLedger（openviking/session/citation_ledger.py）的 JSONL 追加只 flush 不 fsync，掉电可能留下半行。causal_bridges.py 已在追加路径做了 fsync（约 728 行 `os.fsync`），两处策略不一致。加载侧已有坏行跳过+计数（F2d），最坏丢事件——本切片把写入侧补齐。

## 目标契约
1. `CitationLedger._append` 在 flush 后执行 `os.fsync`（对齐 causal_bridges 模式）。
2. 构造参数 `fsync_on_append: bool = True`；False 时保持仅 flush（热路径逃生口）。
3. 不改事件 schema、不改坏行加载策略。

## 允许修改的文件
openviking/session/citation_ledger.py；tests/test_citation_ledger.py。

## 验收
- 新测试：fsync_on_append=True/False 两种参数下批量追加后重载，事件数完整；缺省值为 True。
- `cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_citation_ledger.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件。
