# EvoAgentBench 本地群聊评测说明

维护日期：2026-10-14 09:12 UTC。本文随本轮运行、环境调整和验证结果更新；“待验证”不代表已生效。

## 路径与服务

- 数据与 manifest：`/data/zhoujie/river2_0/evol_bench/EvoAgentBench-ext/`。
- 群聊 harness：`/data/zhoujie/river2_0-main/coforge/benchmark/evolbench-collab/`。
- 四角色代码：`/data/zhoujie/river2_0/.worktrees/openviking-aig-native-fork/benchmark/causal_memory/`。
- `mf_cli`：`/home/zhoujie22/river2_0/mf_cli/`。本机 `/usr/bin/python3` 已有 Playwright；项目 `.venv` 中没有。
- Pi 配置：`/home/zhoujie22/.pi/agent/models.json`，权限 `600`；文档和仓库中不保存 Key。
- Lenovo CA：`/home/zhoujie22/.pi/lenovo-ca-bundle.pem`。

| 服务 | 地址 | 用途 |
|---|---|---|
| CoForge 实例 | `127.0.0.1:8788` | 共享后端，仅此实例 |
| Agent HTTP | `127.0.0.1:18888` | harness 的消息与工具接口 |
| Centrifugo | `127.0.0.1:18000` | 群聊实时连接 |
| OpenViking | `127.0.0.1:1933` | Memory Agent 的记忆接口 |
| verifier | `127.0.0.1:8737` | 显式 `/verify` |

本地探活使用 `curl --noproxy '*' http://127.0.0.1:PORT/health`。外网经 `127.0.0.1:7893` 代理。
SWE 镜像、容器仅使用 `DOCKER_HOST=unix:///data/zhoujie/docker-swe/docker.sock`，不可误用系统 Docker。

## 申请 Gemma 服务

1. 使用 `mf_cli` 的已有登录缓存；需要登录时，从它的私有 `.env` 读取凭据，不把密码放进命令行或文档。
2. 指定模型目录、引擎版本、GPU 数、CPU、内存，以及完整工具调用参数。
3. 等待平台状态 Running，并实际测试模型端点。平台 Running 不保证工具调用可用。
4. 将服务地址和专用 Key 写入权限 `600` 的 Pi 配置；配置文件变更前做同权限备份。
5. 用 Pi 测文本、工具调用及多轮工具结果回传，再用并发短测决定池容量。

```bash
export PYTHONPATH=/home/zhoujie22/river2_0
export SSL_CERT_FILE=/home/zhoujie22/.pi/lenovo-ca-bundle.pem
export NODE_EXTRA_CA_CERTS=/home/zhoujie22/.pi/lenovo-ca-bundle.pem
export HTTPS_PROXY=http://127.0.0.1:7893
export HTTP_PROXY=http://127.0.0.1:7893
umask 077
/usr/bin/python3 -m mf_cli.cli list
/usr/bin/python3 -m mf_cli.cli create \
  --name gemma-4-31b-it-2gpu-N \
  --model-path /dfs/share-read-only/gemma-4-31B-it \
  --model gemma-4-31B-it \
  --gpu A800-8 --gpu-count 2 --cpu 32 --memory 131072 \
  --engine vllm-openai --engine-version v0.31.0 \
  --advance-params '--tensor-parallel-size 2 --max-model-len 131072 --enable-auto-tool-choice --tool-call-parser gemma4' \
  > /tmp/gemma-service-private-receipt.txt
```

`--memory` 的单位是 MiB：`131072` 表示 128 GiB。`create` 和 `endpoint` 会输出 API Key，回执必须私有保存，禁止粘贴进共享日志。
两张 A800 是本轮申请配置，不代表此模型部署的通用最低要求。
[vLLM Gemma 4 官方配置](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html)说明了工具解析器与自动工具选择参数。

## 修改配置与重启

`mf_cli` 已补充 `stop SERVICE_ID --expected-name NAME` 和 `restart SERVICE_ID --expected-name NAME --advance-params ...`：保留既有模型、镜像、资源与 ID，刷新价格令牌并调用平台重启接口。
平台要求原任务先结束；Running 状态直接重启会返回 `S0003: task not finished yet`。
本轮已验证网页停止接口为 `PUT inference/v1alpha1/{id}?force=false`，重启接口为携带完整配置的 `POST inference/v1alpha1/{id}`。
本轮通过 `mf_cli.cli stop` 停止，等待最新状态为 Stopped，再通过 `mf_cli.cli restart` 重启。`status` 已修正为读取最新阶段，避免历史 Running 掩盖当前 Stopped；4 项回归测试通过。
不使用“删除并重新申请”替代原地重启。重启受理后仍需等待 Running、检查参数并重新做 Pi 工具调用测试。

## Pi 配置与 CA 验证

在 `models.json.providers` 下为每个地址设置独立 provider，`api=openai-completions`，`baseUrl` 以 `/llm/v1` 结尾，模型 ID 为 `gemma-4-31B-it`。
`apiKey` 保存在该私有文件中；不要放进文档中的 JSON 示例。

```bash
export NODE_EXTRA_CA_CERTS=/home/zhoujie22/.pi/lenovo-ca-bundle.pem
export SSL_CERT_FILE=/home/zhoujie22/.pi/lenovo-ca-bundle.pem
export NODE_USE_ENV_PROXY=1
pi --provider gemma-4-31b-it-2gpu-1 --model gemma-4-31B-it \
  --no-session --no-tools --offline -p 'Reply exactly OK.'
pi --provider gemma-4-31b-it-2gpu-1 --model gemma-4-31B-it \
  --no-session --tools bash --offline -p 'Use bash to execute printf PI_TOOL_OK, then reply OK.'
```

同时检查 assistant 的 `stopReason` 和工具结果：本机 Pi 即使遇到模型 400，也可能退出码为 0。
不要关闭 TLS 验证来处理证书问题。

## 调度、Agent 与隔离

- 20 题来自 `manifests/evo-swe-pilot20.jsonl`。
- 群聊 Task、Memory 与四角色全部用 `gemma-4-31B-it`，共用 HTTP 请求级 20 路池：旧 Lenovo gateway 4 路、两个专用 2GPU 服务各 8 路；Task/Memory 重叠也计入总量。
- 完成轨迹立即排入“验证 → AO 导出 → Gemma 四角色”，与群聊使用同一个 20-worker 阶段执行器；实际模型请求还受上述共享 HTTP 池约束。
- 四角色为 Builder、Critic、Refiner、Reader。CLI 里的 `gemma` 表示通用 Lenovo 适配器；`--model GLM-5.3-Flash` 才决定实际模型。
- 每题四角色目前完整尝试 3 次、串行执行；`--max-seconds 1800` 仅限制 Builder，不是四角色整体时限。
- 新布局：Memory 留在本地；Task 模型循环、读写与 bash 均在该题 SWE 容器，宿主机 Daemon 管理群聊。旧 r8 已停止，日志与容器差异保留。
- Task 运行时复用本地打包的 Pi SDK、Bun 与 CoForge CLI，不在容器下载完整 Daemon 或 Pi。
- Docker 离线预检已通过两次创建→工具调用→停止→再次创建，并验证停止后身份查询与通信桥。真实首题验证 Memory 的 ov_find/Offer、Task 的消息读取/认领/源码读写后，07:00:47 放行全部题；07:03:49 实查 20 题群聊、20 个容器内 Task worker。
- rootless Docker 无法直接访问宿主机 loopback，容器通过每题目录中的 Unix socket 桥连接模型与原 Daemon 代理；目录挂载允许重启后解析新的 socket，不能单独绑定旧 socket inode。
- 多服务评测不要设置共享 `DEV_MEMORY_API_KEY` 覆盖所有 provider；每题启动时移除此变量，按 Pi provider 读取各自 Key。四角色也使用 Gemma provider 的私有凭据。

每题独立 Workspace、Agent、会话目录及 OpenViking account。它们共享服务算力，不共享当前题记忆。
目前每题从新账号开始，`warm` 标签不表示已加载 train 记忆。

## Train 记忆用于 Test

推荐：train 集完成后冻结一个完整记忆快照；每道 test 初始化独立账号并复制该快照，或使用只读父快照加本题 overlay。
每题可检索全部训练记忆，本题写入仅落本题账号/overlay；其他 test 不可见，训练快照不回写。
记录训练划分、快照 ID/哈希、复制完整性、检索范围及父快照版本。
“可检索全部”不等于一次把所有记忆塞进 prompt。此初始化流程当前未启用，需确定 train 快照来源后实施。

## 验证环境与失败解释

本轮实测 `docker exec ... bash -lc` 的 testbed 环境：Astropy 两题 Python 3.9.20、有 pytest；Django-10097 Python 3.5.6、Django-10554 Python 3.6.13，均无 pytest。
直接 `docker exec ... python3` 会进入基础 Python 3.11.5，与 login shell 的 Conda testbed 不同。
Django 源码仓库没有项目级 `manage.py`，提供 `tests/runtests.py`；Python 3.5 不支持 f-string。

已发现评分侧限制：统一 pytest、测试 ID 未做 shell 引号保护、仅取前 30 个测试、测试结果缺 stderr。
因此 exit 2/4、无法收集测试或 shell 语法错误不能直接当成补丁错误。保留原始 verdict，并把环境/协议错误标为无有效评分信号。
Astropy-12907 的新增参数化案例未被“新增测试函数”提示识别；测试尚不存在时应使用自建复现，不反复寻找 grader 注入案例。
待执行命令若被取消、没有 toolResult，不能视作命令已成功运行。

## Docker 通信桥超时修复（07:12 UTC）

20 题实测中出现 Task 请求 `The socket connection was closed unexpectedly`，无 HTTP 状态码。Memory 请求较短，初期没有同类错误。
复现：上游 12 秒不返回数据，双层 `Bun.serve` 默认设置导致连接关闭并报告 10 秒超时；两层都设 `idleTimeout: 0` 后 HTTP 200。
[官方 idleTimeout 文档](https://bun.sh/docs/runtime/http/server#idletimeout)说明默认 10 秒也作用于进行中的请求及静默流。
宿主机 Unix socket relay 与容器 HTTP relay 均已关闭这个空闲超时；模型 SDK 和 episode 原有超时、重试预算保持不变。
完整 Docker 延迟回归通过：延迟首个模型响应 12 秒，模型→bash→工具结果循环及两次停止/重建均成功。

07:12:31 应用到 r10：保留 9 条已进入 GLM 四角色的轨迹及其原进程，重跑 11 条尚未结束的群聊，evaluation ID 增加 `-runtimefix1`。
旧轨迹会话与日志保留，未完成补丁和配置归档到本轮 `before-bridge-timeout-fix/`；这是重新运行，不把旧半条轨迹并入新轨迹。
当前共享请求池取代旧独立后处理池，任何角色的请求都先领取共享容量；等待退避时释放容量。
复现与延迟预检位于 `/tmp/swe-docker-task-runtime-20261014/bridge-timeout-reproduction.json`、`preflight-delayed/evidence.json`。
部署清单、保留/重跑题号和新 supervisor PID 见本轮 `runtime-fix-rollout.json`。
07:15:26 实查：11 条重跑轨迹已全部启动，共 179 次成功模型输出、0 次模型错误；另外 9 条四角色保持运行。此为短时观察，不等于之后不会发生上游错误。`runtime-fix-validation.json` 保存该观察和 GLM HTTP 状态统计。

本轮 rootless Docker 的 `docker stats`/`docker top` 漏计部分 exec worker，不能据此判定 Task 未启动或只占几百 KiB。
按 `/proc` PID namespace 核对，07:03:49 有 20 个 Task worker，容器进程 RSS 合计约 2.2 GiB（共享页可能重复计数）；未发现旧批次容器残留。
96 个镜像属于缓存，`docker system df` 的共享层统计出现负数，不能把其全部大小当作可回收空间。
宿主机历史 verifier 8735/8736 各约 7 GiB，未确认其他测试是否使用，保持运行；本轮使用 8737。

## Token、重试与归因质量

- 群聊：从 Memory/Task 原始 `.builtin-sessions/*.jsonl` 累加每次 assistant usage，包含重复上下文。
- 四角色：新增即时追加账本 `mXX/four-roles-work/model-usage.jsonl`，记录请求开始/完成、角色、attempt run ID、模型、耗时、HTTP/验证状态、输入/输出/缓存/推理 tokens。
- 每次网络重试分别记录；格式被拒的响应也有消耗。接口不返回 usage 时为未知，进程中止留下未完成请求。
- 最终 `four-roles.json` 附带 `token_usage` 的整体、按角色、按 attempt 汇总；已知 token 是下界，缺项不冒充 0。
- 插桩回归：98 项通过；没有更改模型重试、四角色校验规则和评测预算。
- 旧批次中止前没有保存的四角色 usage 无法可靠补算。

群聊 SDK 默认失败后最多重试 3 次，等待约 2/4/8 秒；网络错误留在原始日志，但不作为文本交给模型。工具错误会交给模型。
单独直连时四角色适配器最多 6 次网络重试；连接中断、408、429 和临时 5xx 使用带抖动的指数退避并读取 Retry-After。共享池集中执行重试，耗尽返回不可重试的传输失败；角色不再将其反馈成格式修正提示。
Critic 返回空违规时必须检查 provider_failures。当前驱动检测到 Critic 调用失败会停止进入 Reader、标记 submit=false；评分门禁拒绝有 provider_failures 的材料。空数组本身不代表审查通过。
AO 导出有文本截断，且主要覆盖 Task 及其收到的 Offer；最终 Reader 结论必须与原始群聊核对。

## 本轮状态与证据（UTC）

- r7：已按用户指令停止，日志与容器差异保留。前 4 题群聊共 1,274,123 tokens，0 次网络错误，4 次超时取消；Django-10097 有补丁但最终发送被取消。
- r8：已停止，8 题曾启动，17 个所属进程已停止，差异归档。
- r9：仅启动首题，发现共享 Key 覆盖、socket 重启失效和停止后身份查询异常；已停止，日志保留。
- r10 群聊 20 条已保存：`/tmp/swe-r10-docker-p20-20261014/20261014T065926Z`；剩余 GLM 已停止，旧结果保留。
- r11 四角色重放：`/tmp/swe-r11-gemma-four-roles-shared20-20261014/latest.txt` 指向当前批次；输入 AO、verdict 与源 SHA256 保存在 `provenance.json`，不重跑群聊。
- 共享池状态：`http://127.0.0.1:18740/status`；真实上游请求/token 审计：`/tmp/swe-shared-gemma-pool-20261014/requests.jsonl`。短跑被替换的四角色日志和 usage 也保留，成本统计应单列。
- 请求错误按当前每题日志统计：`/usr/bin/python3 /tmp/swe-r10-docker-p20-20261014/request_error_audit.py`。归档的旧请求错误需单独统计，不能漏掉重跑前的 token 成本。
- 四角色已观察到上游 HTTP 502，耗时集中在 120.023–120.033 秒，而客户端超时为 240 秒，表明上游存在约 120 秒的截止时间；具体平台原因尚未验证。适配器单独退避重试；它与 Docker 桥的无 HTTP 状态断连不同，不据此推断服务限额。
- 两个 2GPU 服务 ID：`service-large-765-1791957477661`、`service-large-765-1791957477975`。
- 初次 Pi bash 均 400（缺工具解析器），证书验证成功；06:34 停止、06:36 原地重启并添加 gemma4 工具解析器。
- 两个专用服务均 Running，重启后的 Pi bash→工具结果→最终答复完整循环成功，约 2.79–2.85 秒。
- 每服务 2 请求短测共 4/4 HTTP 200，每请求生成 256 tokens，TTFT 0.079–0.140 秒，观察到约 40.9–41.8 输出 tokens/s；不代表 8 题负载下吞吐或官方限额。
- 服务与 Pi 测试证据：`/tmp/swe-docker-task-runtime-20261014/`，其中凭据只在私有配置/备份中。
- 日志分析与 token 测试：`/tmp/swe-four-case-audit-20261014/`。

维护要求：每次变更同时记录实际命令、UTC 时间、配置/源码哈希、批次路径、验证结果和仍未解决的限制。不要把旧批次结果算入新批次。

## 共享池与退避的启动

先运行 `python3 benchmark/evolbench-collab/ops/swe-gemma/llm_pool.py --directory /tmp/gemma-pool --port 18740`，读取私有 Pi 三个 provider；不要在命令行放 Key。
群聊启动环境设置 `COFORGE_LLM_POOL_URL=http://127.0.0.1:18740`，Memory 在 runtimeFetch 路由到池，Docker Task 经宿主 relay 路由到同一池。
四角色 CLI 设置 `--url http://127.0.0.1:18740/llm/v1/chat/completions`；现成重放命令见 ops README。
池只绑定 loopback，校验现有 provider Key。瞬时网络故障、408/429/500/502/503/504 最多重试 6 次，退避为 15、30、60、120 秒，之后以 120 秒封顶，加最多 5 秒抖动并尊重 Retry-After；单请求含排队总预算 900 秒（15 分钟）。四角色客户端通过 LENOVO_GATEWAY_TIMEOUT_SECONDS=960 等待 16 分钟；池内 Gemma 的 Memory/Task SDK 也等待 960 秒且关闭额外 SDK 网络重试。
流式响应完整缓冲并检查 `[DONE]` 后交给 agent，避免半截输出或工具调用被重复执行；会牺牲逐 token 显示速度。重试耗尽明确记为失败，401/400 等配置错误不重试。

## 当前本地 main 部署

CoForge 已拉取并合并 `lrm-lab/coforge` main 的 `d7ac4fc8`；共享池实现提交 `8811f0dc`。OpenViking main 为 `a68b365da`。
前端打开 `http://localhost:8788`，Nginx 同源转发至 main Web 8789，WebSocket 转发至 Centrifugo 18000；实际浏览器页面 HTTP 200、WebSocket 101、无页面错误。
OpenViking main 容器 `coforge-openviking-main-1` 监听 `127.0.0.1:1933`，复用原数据卷；旧 Web/eval18888/代理进程已关闭，旧 OV 容器保持停止供回滚。
部署备份与验证位于 `/tmp/swe-main-submit-20261014/deployment/`（目录私有）：数据库 SQL、OV 数据 tar、迁移日志、页面截图与验证 JSON。
相关测试通过；完整仓库检查仍受用户未跟踪的 `apps/web/repro_tmp.ts` 格式问题影响，完整测试出现 Codex catalog fixture 超时和已有 installer shell 环境问题；未将它们记为通过。

四角色优化：整段读取最多 20,000 字符，按完整 AO 边界截断并提示续读索引。
默认固定三次；调试可用 `--attempt-policy until-verified`，旧素材可传 `--manifest`。
每次 Reader 报告和读取证据保存为 `reader-report.json`，汇总区分提交、冻结和校验。
池路由按健康度及延迟选服务，连续两次瞬态失败冷却 60 秒，恢复时只放一个探测。
完整命令和状态字段见 [运行脚本说明](../benchmark/evolbench-collab/ops/swe-gemma/README.md)。
