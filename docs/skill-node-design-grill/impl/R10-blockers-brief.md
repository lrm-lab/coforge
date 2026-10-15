# R10 派发 #2：卡点测试（双臂能不能真跑起来）

**用户要求**（2026-10-01）：「派cursor进行测试现在的卡点有哪些」。本件＝**用最小代价真跑一遍**，把「现在跑不了」或「跑起来会坏」的每一条找出来，带证据。**这不是实现波，是探路波**：桩能过就过，过不去就把卡点写清楚。

## 0. 硬约束（违反即交回重做）

- **上限 4 个 episode**（两臂各 1 集 ＋ 最多 1 次重试）；单集**超过 30 分钟没产出就停下报卡点**（train 轮就是被 30 分钟超时杀的）。
- **不改 harness**：`evol_bench/`、`memory_graph_evolving/` 里的 Go 侧与 `skillsbench_env_server.py` **一行都不改**。唯一的产物是本件的**桩**（见 §2）与报告。
- **不 push、不建 `ov.conf`、不加依赖**；凭据只从环境文件／pi 模型配置读，**不进 argv**，不打印密钥。
- **不许动**：端口 `18888／1933／8789／8732／8733`、`coforge-openviking-prototype-1`、共享 `coforge` DB。新 sidecar 用 **8731**。
- 开工前先 `df -h /` 与 `docker system df` 记录余量；**可用低于 10 GB 就停下报卡点**，不要清任何东西（清理是用户的决定）。

## 1. 预检（不烧模型／最少 token）

1. **pi 通道是否还活着**：`--provider lenovo-deepseek-v4-flash --model DeepSeek-V4-Flash-0731`（参照 `results/_gms-sb-slb-2026-09-19/run_stage2a_sb_train.sh:9-10`），用 pi 自己的最小调用探活（一次、极短提示），记录它是否需要 `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`。**凭据过期是首要卡点，先探它。**
2. **任务选择**：用**镜像已缓存**的 test 任务，首选 `court-form-filling` 或 `dialogue-parser`（我已验过它们的官方 oracle 今日 `reward=1.0`、各 22 秒）。
3. **记录基线**：`df -h /`、`docker system df`、`docker images | grep -c sbbench`、可用端口 `ss -ltn | grep 8731`。

## 2. 最小 memory plane 桩（本件唯一产物）

位置：`/home/zhoujie22/river2_0/skill-node-design-grill/impl/r10_memory_plane/`（**不放进 OpenViking 主包**）。

必须实现的端点（形状见 `R10-brief.md` §0，字段名以 `memory_graph_evolving/pi-group-chat-host/internal/ports/graph_memory.go` 为准）：
- `PUT /v1/tenant`、`POST /v1/principals`、`POST /v1/spaces`、`POST /v1/grants` —— **幂等**：重复注册返回 2xx ＋ `"duplicate": true`（**不是 4xx**）；
- `POST /v1/recalls` —— 按 `space_ids` 作用域返回；`degradation.state` 别写空串；**要能被开关控制成「返回 0 条」或「返回 1 条固定条文」**（双臂就靠这个开关）；
- `POST /v1/evidence-batches:stage`、`POST /v1/evidence-batches/{id}:commit` —— **回 2xx 并 no-op**（非 2xx 会让 episode fail-closed 记成 infrastructure 失败）。

另外：鉴权 `Authorization: Bearer <token>`、明文 HTTP；**桩自己把每次 recall 的请求与响应全文写 JSONL**（派发 #1 的 C1，也是 placebo 臂将来的账）。

## 3. 跑（两步，各一集）

1. **cold**：sidecar（8731，`--log /tmp/r10/lifecycle.jsonl`）＋ `bench-runner --gms-url http://127.0.0.1:<桩端口> --gms-token <token> --out-dir .../results/r10-blockers-cold`，**单臂单集**（`--manifest` 里只留 1 个 test 任务；参考 `run_stage2a_sb_train.sh` 的完整参数）。
2. **our**：同样跑一次，但桩开关＝返回 1 条条文，`--out-dir .../results/r10-blockers-our`。

**硬门（必须逐条给证据）**：
- ① `our` 那一集的 **Pi 转录里真出现 `--- recalled memory` 段**（路径：`work-warm/episodes/<seq>-*/<ts>_*.jsonl` 的**首条 user 消息**；我已验过这个抓法在 `sb-smoke-local-1` 的暖臂转录上可行）；
- ② `cold` 那一集的对应位置是 `no recalled evidence (state=empty)`；
- ③ 容器真建起来并用**官方 verifier** 判出 `reward`；
- ④ 合并两份 `attempts.jsonl` 后 `skillsbench_grading.py` **能算出 `memory_gain`**（即双臂配对在判分侧成立）。

## 4. 交回

1. **卡点清单**（本件主产物）：每条写 现象／证据（路径＋原文片段）／根因判断／最小解法／**是否要用户裁定**（如凭据、磁盘、超时）；
2. 桩的位置、启动命令、开关用法；
3. §3 四条硬门的逐条结果（**过就是过、没过就是没过**，不许含糊）；
4. 原始命令与日志路径（我要能逐步复现）；
5. **未能回答的项**单列（不许用猜测填空）。

## 5. 不许读成

- 这一集的结果**不是**「记忆有没有用」的证据（n=1）。本件只回答「管道通不通、卡点在哪」。
- 跑通也不代表可以全量：全量前仍需用户裁定规模与磁盘（`R10-design.md` §7）。
