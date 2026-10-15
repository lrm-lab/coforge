# H1：检索匹配修复——casefold 与投影内容解析（LoCoMo 探针发现的两个缺陷）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 main，已检出）

## 背景
LoCoMo 零 LLM 探针（419 消息 ingest → fallback 视图 → facade 检索）暴露两个检索层缺陷：
1. `openviking/session/retrieval_facade.py` 的 `_text_hits` 是大小写敏感的整串子串匹配（`query.text in haystack`）：查询 `"caroline"` 0 命中、`"Caroline"` 2 命中——同一个词大小写不同结果不同。
2. `InfluenceProjectionAdapter.search` 的可检索文本只含投影卡自带的摘要文本；fallback 视图块的 SourceRef 只带 content_hash 不带正文，导致 Block/Claim 投影通道对任何内容关键词不可见（内容词只能命中 fact 原子卡，臂 B 形同虚设）。

## 目标契约
1. `_text_hits`：双侧 `str.casefold()` 归一后再做子串判断；保持"查询文本为空 = 全匹配"的现行为；docstring 标注大小写不敏感。`_score` 现为常数，不动。
2. `InfluenceProjectionAdapter.__init__` 增加可选参数 `content_resolver: Callable[[str], str] | None = None`（语义：ao_id → 该 AO 的正文文本）。`search` 的命中判定文本在现有基础上额外拼接：依据卡片 source_pointer 的 `view_revision_id` 从 `self._views` 找到对应 block/claim 的 source refs，逐 ao_id 调用 resolver 取文本。约束：
   - resolver 为 None、view 未绑定、或解析结果为空时，回退现行为（仅摘要匹配），不抛错；
   - 解析出的正文**只用于匹配判定**，不得写入返回卡片或 source_pointer（防扩攻击面）；
   - 不得改变 ACL、配额、8/4 通道、12 夹紧、selection_audit 任何语义。
3. 测试：
   - casefold：小写查询命中大写正文、反之亦然；空文本仍全匹配；
   - resolver：注入后 block 投影卡可被内容关键词命中（fact 卡不受影响）；不注入时行为与现状一致。

## 允许修改的文件
openviking/session/retrieval_facade.py；tests/test_retrieval_facade.py。

## 验收
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_retrieval_facade.py -q` 全绿；并跑全套回归确认无破坏：
`python -m pytest tests/test_ao_ledger.py tests/test_ao_ledger_reader.py tests/test_ao_ledger_recorder.py tests/test_causal_bridges.py tests/test_causal_clusters.py tests/test_causal_experiences.py tests/test_citation_ledger.py tests/test_evaluation_loop.py tests/test_evaluation_orchestrator.py tests/test_fork_revision_lifecycle.py tests/test_handoff_envelope.py tests/test_influence_projection.py tests/test_influence_view.py tests/test_memory_hints.py tests/test_memory_lifecycle.py tests/test_outcome_utility.py tests/test_retrieval_facade.py tests/test_skill_invocation_capture.py tests/test_trajectory_index.py -q`
粘贴两段输出。

【硬约束】禁止执行任何 git 命令；只改允许文件；不得放宽既有 ACL/配额/夹紧逻辑。
