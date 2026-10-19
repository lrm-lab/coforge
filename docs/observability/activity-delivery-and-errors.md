# Activity 发送与错误转换

## WSS Activity 发送

Activity 是观测数据，不采用可靠消息语义。Daemon 调用 Centrifugo client publication 后
立即继续，不等待业务确认；不写 spool，也不影响 Agent 生命周期、状态或聊天消息。
断线期间只在内存中为每个 Agent 替换保存最新一条 Activity；新 launch 会淘汰旧 launch
pending，重连后每个 Agent 最多刷新这一条。显式 stop 清空 pending。该 bounded refresh
不是历史 replay；publish proxy 或 observer 失败仍直接丢弃且不重试。
Centrifugo 仅在 `activity` namespace 开启 publish proxy；Backend 根据服务端附加的连接
metadata 校验 Workspace、Computer、Agent 与 payload scope，并禁止 Daemon 向 control
channel 发布。通过校验的 observation 按 `(agent_id, launch_id, client_seq)` 幂等写入
PostgreSQL；`computer_id` 只取可信 connection metadata，不接受 payload 自报。Agent
详情页读取最近 500 条持久 observation，并用最近一条展示最近观测到的 Computer。写入
失败不会反向改变 publication 结果，因此该历史仍可能缺项。单条连接通常保留发送次序，
但消费者不得依赖 Activity 完整、有序或唯一。

错误至少覆盖这些归类：可执行文件不存在或无权限、工作目录或 skills 初始化失败、
provider 初始化/认证失败、模型或 reasoning 配置不支持、Agent capacity 不足、进程
异常退出、provider API 网络/认证/限流/额度错误、上下文或 token 限制、工具权限拒绝、
协议解析或超时失败。警告至少覆盖 provider 返回的 warning、接近限流或额度阈值、可重试
网络退避、上下文接近上限和可选能力不可用。归类到这些稳定类别是 Daemon 核心的职责（见下），
原始错误只作为本地诊断；stderr 不能直接作为发给服务端和前端的 `message`。

## 启动首轮与就绪

新会话没有真实恢复输入时发送 `Start.`；恢复空会话时发送明确的无工作首轮。
`resumePrompt` 或真实消息恢复优先，同一启动中的后续真实输入会取代尚未发送的空首轮。
已经开启初始化轮的 provider 不再收到额外首轮。仅有未读摘要时，启动输入要求每个
目标读取一次；只有明确交给该 Agent 的工作才继续处理。

会话创建后，Daemon 发布 `starting`，并启动 120 秒的首次模型就绪计时。
Session、usage 和传输 progress 不能证明模型已就绪；真实 turn Activity 或 turn outcome
结束该计时。首轮完成发布普通 `idle`，因此 Activity 历史也能结束 Starting。
超时或首轮输入在就绪前被拒绝时，报告 `runtime_error` 并释放本次会话。
Stop、进程退出和 Daemon shutdown 撤销计时；就绪后的长任务不受这个启动时限影响。

## 主动停止与取消投递

主动 Stop（重启的停止阶段也一样）先关闭输入入口，并取消尚未被会话确认的通知，
随后立即释放运行时；不得先等输入队列、恢复通知或当前回合自然结束再释放会话。
待会话清理完成后，停止操作才收尾此前的启动和输入处理，替换会话必须等待停止成功。

取消的普通投递不发送 ACK，仍由云端恢复未读状态。排队中、正在通知或等待回合结束的
tracked mention 报告 `DELIVERY_REJECTED`，不因取消而报告 drained 或发送成功 ACK。
此前已消费或已成功确认的投递保持原有结算。迟到的通知接受结果不能修改替换会话的
attention 或确认旧投递；意外退出仍沿用原有的身份和恢复语义。

外部运行时立即收到进程树终止请求；等待退出时给它 5 秒正常退出时间，仍未退出则
强制终止，再等待最多 5 秒确认退出。进程树无法确认退出时停止失败，阻止替换启动并
显示已有的停止失败 Activity。Grok 的后台等待和现有每回合进程适配器不因此改变。

## 错误与重连的单一转换点

`AgentRuntimeEvent`（`packages/agent/src/contract.ts`）的 `error` 成员
（`message`、可选的 `retryable`/`providerErrorCode`/`providerErrorClass`/
`providerErrorReason`/`occurredAt`）和 `reconnecting` 成员（`attempt`/
`message`）是四个 provider（Claude Code、Codex、Kiro、Pi）唯一允许上报运行时失败
和重连的方式，只携带原始事实，不带格式化或分类。`packages/daemon/src/agent-runtime/
runtime-error-activity.ts` 是把这些事实变成可见 Activity 的唯一位置：provider 报错文案
原样显示；崩溃摘要（`Crashed (...)`）脱敏并截断到 512 个 Unicode 码点；附带的 `Error: …` trajectory
entry，以及运行中错误的 `runtimeError`（`errorClass`/
`errorReason`/`fingerprint`）结构化字段的分类，都只在这一个模块里发生（启动失败的分类见下方
[启动失败原因](#启动失败原因)，在 `launch-failure.ts`）；`error` 事件
额外携带的 `providerErrorCode`/`providerErrorClass`/`providerErrorReason` 会被优先
采用（例如 Codex 的 turn 失败带着原生错误码和 `turn_failed` 这个比通用分类更精确的
reason），否则退回到通用的 `AgentRuntimeError`/`runtime_failure`。没有任何
`code-agent/*/provider.ts` 文件再自行构造 `runtime_error`/`runtime_crashed`/
`runtime_reconnecting` 的 Activity。

`AgentSession.onExit` 本身不带退出码或信号，所以 Daemon 核心区分「进程崩溃」
（`runtime_crashed`，文案 `Crashed (...)`) 和其他非主动退出（沿用 `stopped` 文案，
因为 Agent 的控制状态此时同样是 stopped）时，唯一可用的事实是：这次退出之前最近一次
`error` 事件是否已经被一个 `completed` 事件解决过。

## 启动失败原因

`LauncherError` 类下有两套 reason，互不混用：

- 运行中（turn 里）的 provider 报错按文案匹配，由 `runtime-error-classification.ts` 归为
  `LauncherError`/`launcher_error`（例如报错文本里出现 `ENOENT`、`command not found`）。
- 启动失败（进程没起来）由 `packages/daemon/src/agent-runtime/launch-failure.ts` 的
  `LAUNCH_FAILURE_REASON` 给出，只看类型化错误的 `code`，从不匹配文案。约定：知道原因的地方
  抛一个带 `readonly code`（即该 reason）的 Error 子类；上层用 `hasErrorCode` 判定。

启动失败时 Daemon 发送 `agent:status(inactive)` 和一条 `runtime_error` Activity
（`runtimeError.errorClass=LauncherError`，`errorReason` 为下表之一），并记一条
`agent_runtime:launch_failed` 日志（`failure_reason`、脱敏后的 `error_message`、Pi SDK 的
trace）；`agent_control:launch_retry_scheduled`/`launch_failed` 带同样的字段。

| errorReason | 抛出位置 | `detail` 给出的下一步 |
| --- | --- | --- |
| `agent_authorization_failed` | `AgentAuthorizationError`：向服务端申请启动配置和 Agent API key 失败 | `coforge-computer status` 查看 Workspace 连接和版本，落后于服务端时 `coforge-computer upgrade` |
| `runtime_not_found` | `RuntimeExecutableNotFoundError`：spawner 在 Agent 的 PATH 上找不到 runtime 可执行文件（直接 spawn 与 launchd 一致；其他 `ENOENT` 不算） | 安装该 runtime |
| `runtime_version_too_old` | `RuntimeVersionUnsupportedError`：CLI 版本低于支持的最低版本 | 版本门禁原文：升级哪个可执行文件 |
| `model_not_found` | `RuntimeModelNotFoundError`：runtime 没有所选模型（Pi 的 `PI_LAUNCH_MODEL_MISSING`），`detail` 写出模型名（最多 128 个码点） | 在 Agent 设置里换一个模型 |
| `model_provider_not_configured` | `ModelProviderSettingError`：模型提供方缺失、未配置或与所选模型不符 | 在 Agent 设置里配置模型提供方 |
| `runtime_spawn_failed` | 其余情况 | `coforge-computer logs` 查看原因 |

控制结果仍是 `launch_failed`；原因不改变启动重试次数和退避。Activity 仍用 `runtime_error`，
不用 `runtime_unavailable`：后者在 Web 上显示为 working，只用于冷启动新 session。
