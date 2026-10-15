# R9m-fix 派发：模型模式的单集失败不许拖垮整轮 ＋ 模型模式报告如实报 snapshot_source

## 背景（首跑真模型，2026-10-01）

用户点名「模型驱动抽取，写真正的边和子图」。我按设计 #159「提供方由操作方注入」写了操作侧句柄（本机唯一能用的模型通道是 Cursor CLI，句柄在 `/tmp/probes/r9m_run.py`，**不是生产**），把生产 `--mode model` 路径第一次真跑起来：

- episode 0001：一次调用通过（0 修复），生产解析器接受，写出 6 块／5 条真边／1 个真子图（含 2 条失败证据）。这份是对的，不用管。
- episode 0002：**两次响应都在 JSON 前带一句中文叙述**（首字符分别是「正」「我」），生产解析器按 fail-closed 拒绝（**这是正确行为，不许放宽**）；随后 `run_model_episode` 不接异常 ⇒ `ExtractionContractError` 穿透 `main()` ⇒ **整轮在第 2 集终止，报告一个字都没写出**。

证据（我留的原始件）：

- `/tmp/r9m/calls/call-001/response.txt`（ep 0002 第一次，17104 字符里前 20 字符是叙述，JSON 体在 `{` 之后）
- `/tmp/r9m/calls/call-002/response.txt`（ep 0002 修复轮，同样带叙述；`message-3.txt` 就是生产塞进去的报错文本）
- `/tmp/r9m/run-full.log` 的 traceback（栈底 `response is not JSON: Expecting value: line 1 column 1 (char 0)`）

**这不是契约的缺陷**：真模型输出带叙述是模型侧格式合规问题，契约要的是「只接受 JSON」，靠 prompt＋修复轮去纠；而修复额只有 1 次，所以**单集失败是可能发生的正常结果**，跑分件必须能把它记下来并继续。本轮要修的就是这件事，外加一条 R9-fix 验证时记下的残余。

## 要改的（只此一个 benchmark 文件，外加测试文件新增）

文件：`benchmark/causal_memory/r9_model_extraction.py`

### 1. 模型模式单集隔离（把 try/except 放在 `run_model_episode` 里，因为它拿得到 `provider`）

`run_model_episode(...)` 里，从建 factory 起（含 factory 本身、`provider(...)` 调用、`freeze_extracted_view`、`ViewSupersedeIndex` 注册）整段包 try/except `Exception`。捕获后**返回一条失败记录**而不是抛出：

```python
{
  "episode_id": <同成功记录>,
  "compliant": False,
  "error": {"type": <异常类名>, "message": <str(exc)[:500]>},
  "calls": <provider.calls 若已建出 provider 否则 0>,
  "repairs": <provider.repairs …>,
  "usage": <字典或字符串 "unavailable"：与成功记录同一约定——测到才是字典>,
  "usage_source": <同成功记录约定；没测到就是 "unavailable">,
  "finish_reasons": <list[str]>,
  "truncated": <int>,
}
```

要求：

- **不许吞掉不记**：失败必须进报告，能被数出来；**不许把失败写成成功**（`compliant` 只在这条记录里为 `False`）。
- **不许放宽任何校验**：生产解析器／提供方／冻结路径一行不改，失败就是失败。
- 成功记录的字段与取值**逐字不变**（`/tmp/r9m/run/report-0001.json` 是 episode 0001 的既有成功记录，可当参照）。
- `main()` 的 model 分支里那条 `print(f"{episode_dir.name} compliant=... tokens=... usage_source=... repairs=...")` 遇到失败记录不许崩（打印 `compliant=False error=<type>` 之类即可）。

### 2. 报告加失败计数（**只加在 model 模式**）

model 模式的 `_report` 汇总加 `"failures": <int>` 与 `"failed_episodes": [<episode_id>…]`（按 `episode_id` 排序）。成功集的其他汇总键不变。

**硬门 ②：fake 模式两种 snapshot-source 的报告必须逐字节不变**（下面给了 SHA256 钉）。

### 3. 模型模式如实报 `snapshot_source`

模型模式的**控制台回声**与**报告**都写 `snapshot_source: "ledger"`（现在控制台打印 argparse 的值，默认 `canvas`，与事实不符——模型模式只有真台账来源，见 `R9-verification.md` §7.4 残余 ②）。fake 模式两种来源的回声与报告**不变**。

### 4. 测试（写进 `tests/test_extraction_contract.py`，零模型调用）

- 假句柄（`get_completion_async` 返回**非 JSON 文本**）经 `main(["--mode","model", …])` 跑一个 episode ⇒ 不抛异常、报告里该集 `compliant=False` 且 `error.type` 非空、`summary.failures >= 1`。
- 同一假句柄跑**两个** episode ⇒ 两条都被记（证明循环继续），且 `failed_episodes` 两条都在。多集用 `--episode` 前缀选不到两个不同前缀时，可以直接调你新加的那层封装（例如把「跑一个 episode 并兜错」抽成小函数）——由你定，但**不许真调模型、不许写固定路径**，报告输出用 `tmp_path`。
- 假句柄返回**合法 JSON** 的路径保持能落库（沿用既有测试的写法）。
- 既有测试一行不改（除本波新增）。

## 硬门（交回时逐条贴实测输出）

1. **零模型调用**：本波只用假句柄与 fake 模式。
2. **零模型侧的字节钉**：
   - `--mode fake --out <tmp>/canvas.json` 的报告 SHA256 **必须是** `29b8f36e08370b05a2577daf76e0473e1f84e09920ef6f86938f629ba5fff7e5`
   - `--mode fake --snapshot-source ledger --out <tmp>/ledger.json` 的报告 SHA256 **必须是** `4cddafd20cbec618739f6000e02b30ed38119e44d86486677848b47fe6051729`
3. **受影响区同一命令**：`pytest tests/test_extraction_contract.py tests/test_trajectory_index.py tests/session/test_phase2_causal_seam.py tests/test_extraction_write.py -q --no-cov -p no:cacheprovider` ⇒ 除本波新增用例全过外，**仍是 2 failed／84 passed**（那两条既有 caplog 失败不许顺手修）。
4. **`ruff check` ＋ `ruff format --check`** 对该文件与测试文件通过。
5. **禁令路径**：`openviking/` 下任何文件一行不改；`benchmark/causal_memory/l1_locomo_hitk.py` 字节不变；不新建配置文件、不读配置、不新增依赖。

## 交回

一个 git commit（**不要 push**）。回复里贴：commit 短哈希、改动文件与行数（`--numstat`）、上面五条硬门的实测输出、以及描述失败记录时**明确说清**「哪些字段是失败时可能拿不到的」。
