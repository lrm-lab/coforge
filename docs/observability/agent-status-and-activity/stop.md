# Stop 一定完成

Stop（含放弃启动、整个 Daemon 停止）不会因为进程不肯退出而失败，也不留下需要“再 Start 清理、再 Stop
重试”的状态。

1. `AgentProcessManager.stop` 给 provider 的 `dispose` 一个总期限（`AGENT_STOP_DEADLINE_MS`，25 秒）。
   JSONL/ACP 进程的清理梯子（SIGTERM、等 10 秒、SIGKILL 进程树、再等 10 秒）加上输出收尾
   （`PROCESS_OUTPUT_DRAIN_MS`，3 秒）都在这个期限之内；Pi 这类进程内 provider 的 `dispose` 同样受它约束。
2. `dispose` 失败或超时后，对该 Agent 的启动标记（launch tag）做一次不留情的 sweep：SIGTERM，短暂等待，再
   SIGKILL。sweep 自己也有期限（`AGENT_STOP_SWEEP_DEADLINE_MS`，5 秒）。
3. 之后无论结果如何，Agent 照常被释放：runtime 移出、上报 `inactive`、投递闸门/注意力/离线驻留清理，控制
   记录的 stop 结果为 `stopped`。第二个并发的 Stop 加入第一个，不会报错。

| 日志事件                         | 级别 | 含义                                                                                         |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| `agent_runtime:stop_unconfirmed` | warn | sweep 后仍有进程活着：`survivors`（`pid`、`reason`）；不产生 Activity，也不阻止下一次 Start |

下一次 Start 对这样的 Agent（以及上次退出时进程树未能确认清理的 Agent）先 sweep 一次，同样有期限，然后照常
launch，所以同一 Agent 正常情况下不会有两个进程。仍可能出现的只有：SIGKILL 之后进程处于不可中断状态、sweep
在期限内没杀完、或进程在 sweep 的进程表快照之后才 fork。

`dispose` 超时或被拒会先记一条 `agent_runtime:stop_forced`（warn，`reason` 为 `timeout` 或 `failed`）。放弃等待
的进程内 provider 会话可能继续在 Daemon 里运行，直到它自己结束。Stop 若遇到进行中的 `release()`，先等它
结束，所以最坏耗时是 release 的期限加 30 秒。

`release()`（冷空闲、配置应用、卡住重启）不属于 Stop：它保留 runtime，进程在自己的期限内不退出就报失败。

Start 等待 Agent 已在进行的 Stop 结束后再 launch；Stop 进行中，运行态判断为“未运行”，Start 不会 rebind 到
正在被停止的进程。启动超时（`AGENT_STARTUP_TIMEOUT_MS`）的计时器若在窗口之外很久才触发（Computer 睡眠
期间事件循环被冻住），窗口重新开始，不会放弃一个仍然存活的进程。
