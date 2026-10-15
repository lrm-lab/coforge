# 交接：ADR-0045 SWE gemma 20 路（2026-10-13）

日期：2026-10-13。仓库：`/data/zhoujie/river2_0-main/coforge`（main，未提交、未推送）。设计依据：`/data/zhoujie/river2_0/skill-node-design-grill/docs/adr/0045-verdict-injection-attribution-modes.md`。四角色实现在 OpenViking fork：`/data/zhoujie/river2_0/.worktrees/openviking-aig-native-fork/openviking/session/aig_role_chain.py`。

## 现在停在哪

`evoswe-gemma-r4` 20 题已全部结束，成功 0。分片进程已退出，监视器 `/tmp/gemma-r4-watch.log` 在 09:55:46 写了 `ALL_DONE`。结果在 `benchmark/evolbench-collab/result/evoswe-gemma-r4-m00-attempts.jsonl` 到 `m19`。每题 `status=failure`、`error=episode timeout`、`task_message_count=0`、`final_output` 为空。

| 机制 | 题数 | 含义 |
|---|---|---|
| `no_reply` | 11 | 有带引用的 Offer，45 分钟内 Task 没有在频道交出答案 |
| `leak` | 6 | 有带引用的 Offer，Memory 又发了 Offer 以外的频道消息，Task 仍无答案 |
| `no_offer` | 3 | astropy-13033、sklearn-10844、sympy-11618，约 25 分钟安静超时，没有 Offer |

私有 dockerd `unix:///data/zhoujie/docker-swe/docker.sock` 上还留着约 17 个 `swe-*` 容器，是这批结束后没收。评测进程已经不在，容器名会被下一批 `docker run` 撞上。

**没有开始 builder / critic / refiner / reader，也没有写 fork。** 见文末「为什么现在不能注入」。

## 这四批分别是什么

清单：`/data/zhoujie/river2_0/evol_bench/EvoAgentBench-ext/manifests/evo-swe-pilot20.jsonl`。每批 20 路，`mod 20:k`，arm=`warm`，family=`software_engineering`，Memory 和 Task 都是 `lenovo-gemma` / `gemma-4-31B-it`。单题上限 45 分钟（`COFORGE_EVAL_EPISODE_TIMEOUT_MS=2700000`），无 Offer 且无 Task 消息时 25 分钟安静中止（`COFORGE_EVAL_ABORT_QUIET_MS=1500000`）。20 路意味着每题自己的 OpenViking 账号，跨题 warm 记忆不会累积。`COFORGE_EVAL_RESUME=1` 会跳过该 evaluation id 已经写下的 `run_id`，所以失败批必须换新编号，不能续跑。

| 编号 | 结果 | 原因 |
|---|---|---|
| `evoswe-gemma-m00`–`m19` | 20× `no_offer`，无轨迹 | 评测 `channels.send` 传了 `requestId`，main 的 `PublicChannels.send` 只读 `idempotencyKey`。protobuf 省掉 request_id，daemon 丢帧 |
| `evoswe-gemma-r2` | 中途停掉，不能用 | OpenViking 处理函数接到了不存在的 `DaemonRuntime.agentOpenviking`，调用抛 `is not a function` |
| `evoswe-gemma-r3` | 20× 超时：10 `no_reply`、5 `leak`、5 `no_offer` | 记忆调用已通。`coforge task claim` 全部 404，因为评测代理没接 `agentTask`。Task 收到 404 后仍进了容器，但频道没有答案 |
| `evoswe-gemma-r4` | 上表，当前有效的一批 | `agentTask` 已接上。claim 成功过（17 次 claimed，0 次 `CLAIM_FAILED`）。零分来自 Task 没交频道答案，以及 3 题无 Offer、6 题 Memory 多发了消息 |

启动脚本（不在 git 里）：`/tmp/evol-shard-main.sh`、`/tmp/launch-gemma-r4-main20.sh`、`/tmp/gemma-r4-watch.sh`。runner 的 cwd 是 `/data/zhoujie/river2_0-main/coforge`。标准输出被 bun 块缓冲，分片日志会停在 `agent_control:operation_superseded`，这不代表卡死；daemon 日志在 `/tmp/evol-daemon-*/logs/daemon/daemon.jsonl`。

## 已改、未提交的代码

工作区相对 main 有 11 个已改文件，+40/−8。不要把下面这些未跟踪目录一并提交：`.agents/skills/grill-with-traceability/`、`apps/web/repro_tmp.ts`、`apps/web/vite.eval.config.ts`、`docs/skill-node-design-grill/`、`docs/whowhenpro-bcrr-attribution-grill/`、`benchmark/causal_memory/out/`、prisma client。

1. 四个 `benchmark/*/src/eval-qa.ts`：`channels.send` 改为 `idempotencyKey: crypto.randomUUID()`。涉及 evolbench、skillsbench、public-channel-memory、longmemeval。
2. `apps/web/src/server/conversations/public-channels.server.ts`：空白 `idempotencyKey` 在发布前抛 `AppError("INVALID_INPUT")`。
3. `packages/coforge-sdk/src/internal/codec.ts`：`encodeAgentMessageDelivery` 拒绝空 `requestId`。`agent-message.test.ts` 有对应测试（本会话跑过，28 通过）。解码器不要放宽。
4. 四个 `benchmark/*/src/eval-daemon.ts`：`agentOpenviking` 改为 `runtimeApi().agentRequests.agentOpenviking(...)`。方法在 `AgentRequestForwarder` 上，不在 `DaemonRuntime` 上。
5. 同一四个文件：补上 `agentTask: (context, request, agentApiKey) => runtimeApi().agentTask(...)`。方法在 `DaemonRuntime` 上。正式 daemon 的对照是 `packages/daemon/index.ts`。

还没改、上一轮已经说清的优化：`packages/daemon/src/code-agent/agent-instructions.ts` 的 `MEMORY_AGENT_CHANNEL_TOOLS` 仍包含 `send_channel_message`，提示词末尾还有可复制示例。站立指令已经写了「@memory 只能用 `memory_offer`」。r4 里模型仍调用 `send_channel_message`，服务器回 `An explicit @memory question must be answered with memory_offer`，daemon 记 `AGENT_MESSAGE_VALIDATION_FAILED`。m09 连拒两次。建议从 Memory 工具表拿掉 `send_channel_message`，只留 `message_check` 和 `message_read`。这处改动不会作用到已经结束的 r4。

## 日志里还在响、但没有判这批作废的两项

- **mention `report_failed`**：daemon 上报 `agent:v1:mention_delivery:transition`。Centrifugo（`coforge-centrifugo-host`）把它转到九月构建的 8788，回 `404 unknown RPC method`。抛出的对象不是 `Error`，所以 `error_code` 写成 `UnknownError`。`mention-delivery-tracker.ts` 的 `#send` 失败只记日志。例子：09:07:01，delivery `62e1c8d3-4449-4076-8d96-3e493086c464`，阶段 `daemon_received`。当前 main 已有 `createMentionDeliveryTransitionMethod`，8788 没加载它。不要为这条重编或重启 8788。若要消警告，同一条连接第一次见到 unknown method 之后停止再报即可。
- **消息校验 400**：见上一节。这是服务器按设计拒绝普通频道消息，不是代理丢帧。

## 为什么现在不能注入四角色

ADR-0045 的触发规则：verifier fail → fail 模式；verifier pass → success 模式；无信号 → 不启动 builder/critic/refiner/reader，也不写 fork。agent 没交出可评产物（无 patch）归 fail；评判方没评成（`graded=false`、验证器异常）归无信号。失败构图若走 fallback，保持 `fallback` / `provisional`，`propose_fork` 在 fallback、报告未冻结、或 `READ_VERIFY` 期间都禁止。

r4 没有验证器裁决。启动脚本没有设 verify sidecar，attempt 里没有 `sidecar_verification`。机制列来自信道消息分类（`benchmark/evolbench-collab/src/leak.ts`），不是 SWE `/verify`。20 题的 `final_output` 都是空的，Task 没有在频道交出补丁。因此：

- 不能把 `no_reply` / `leak` / `no_offer` 直接当成 verifier fail 送进四角色。
- 不能把「评测超时」当成无信号就忽略；无信号专指评判方没评成。这批是评判方还没跑。
- 注入入口是评测直连：sidecar `/verify` 的 `{reward, graded, error}` 加 attempt 记录，再导出 AO 快照。材料脚本在 fork 的 `benchmark/causal_memory/aig0045_real_material.py`。真材冒烟用的 backbone 是 `GLM-5.3-Flash`，不是这批的 gemma。SWE 域在 ADR 收口时仍标为延后。

下一轮若要做注入，顺序是：先对有频道轨迹的题跑 SWE sidecar 复验（交接里写过的端口是 8737），再按 ADR 归一化。`graded=false` 的行停在无信号。只有归一化之后的 verifier fail / pass 才进四角色。3 条 `no_offer` 没有 Offer，不要和有轨迹的 17 条混成同一批素材。这批不能拿去报 resolved rate。

## 环境约束（下一轮不要破坏）

- 不推送，不提交，除非用户明确要求。不新增依赖。不修已知的 10 个基线失败测试。不用 gpt-oss。
- 不改 `/home/zhoujie22/river2_0`，除非用户再次明确要求。`/home/zhoujie22/river2_0` 与 `/data/zhoujie/root-disk/home/zhoujie22/river2_0` 是同一棵目录。
- 8788 保持单实例，不要启动第二个，不要用这批理由重编。Agent HTTP 走 18888（main 的 vite，`apps/web/vite.eval.config.ts` 未跟踪）。Centrifugo 在 18000，经 8789 代理到 8788。
- OpenViking 容器 `coforge-openviking-prototype-1` 只读，端口 1933，不要重启。密钥是 gitignore 的符号链接：`coforge/infra/secrets/openviking_prototype_ov_conf` → `cursor-ov-cm-impl` 那份。不要打印内容。账号键文件 `/tmp/pcm-eval-ov-keys.json`。
- 不重启 `/data/docker` 上的系统 dockerd。SWE 容器只用 `DOCKER_HOST=unix:///data/zhoujie/docker-swe/docker.sock`。
- 本机 HTTP 走代理 `127.0.0.1:7893`，探活要用 `curl --noproxy '*'`。
- `pkill -f` 会匹配当前命令行。只按精确 PID 杀。不要误伤无关的 `evol-warm4`。
- 本地库 `127.0.0.1:5432` / 库名 `coforge` 已经跑过 main 的 12 个迁移（含 `users.email`，并曾删掉 `workspace_invitations`）。不要再 migrate。8788 的九月包仍可能查旧表。
- 回复用简体中文。
