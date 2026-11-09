# Raft 1.0.65 Context View 对齐审计

审计对象：`/private/tmp/coforge-context-work`（`feat/agent-context-view` 工作树）。对照包：`/private/tmp/raft-research-current/sea/assets/computer.cjs`。本次复核只改本文档，不改源码；“已对齐”表示当前源码有直接证据，“未验证”表示还没有真实运行链路证据。

## 版本与来源

`provenance.json`：version `1.0.65`；target `darwin-arm64`；release_id `71def837-5d15-4ec8-9b31-8a8bbcbb7e5a`；binary SHA-256 `61efe1bc561d0504ee92c3544dc0e8e5796f8d9ce4c14c30e29828c6c0f242bf`；gzip SHA-256 `8a5cff31bd2b711c9f02fc0d6fcd8a8f7f8bfb80773805439ff947543cdd5f69`；Node `24.22.1`；观察时间 `2026-11-08T15:47:12.940Z`（`observed_on: 2026-11-08`，source `hands.build updates/check`）。

Raft bundle 中用于本次比对的可定位字符串/模块包括：`contextViewSourceMaxBytes`、`findContextViewIndexLine`、`observeFlag`/`applyServerFlag`、`oom_score_adj`、`pi-requests`、`AGENT_CONTEXT_VIEW_FAILURE_REASONS`，均在 `computer.cjs` 的内联模块路径（`packages/daemon/src/agentContextView/*`、`packages/shared/src/agentContextView/*`、`packages/daemon/src/oomScore.ts`）中观察到。

## 当前已对齐

| 能力 | CoForge 证据 | Raft 1.0.65 对照 |
| --- | --- | --- |
| Capability、生命周期 | `packages/daemon/src/agent-context-view/agent-context-view-service.ts`；ready/heartbeat lease、availability TTL、stop maintenance | `agentContextView` capability、lease、startup/sweep |
| Protocol、索引 | `packages/coforge-sdk/proto/coforge/rpc/v1/agent_context_view.proto`、protobuf codec、`daemon:v1:agent_context:view` / `_result`、`agent:v1:context:availability`；`context-view-store.ts` 的 30 天 compaction、8 MiB cap、atomic rename、`O_NOFOLLOW`、regular-file/nlink 校验 | `AGENT_CONTEXT_VIEW_*` wire constants；`findContextViewIndexLine`、8 MiB index、私有文件约束 |
| Scope、鉴权、上传 | `context-view-query-handlers.ts`；workspace/computer scope；daemon bearer + Agent API key；gzip/30 s/`x-raft-context-uncompressed-bytes`；Web 端 32 MiB 解压、8 MiB 压缩限制和 protobuf 重解码 | `postContextViewResult`、Agent key、30 s bounded result、gzip JSON |
| Source 安全 | `context-view-source.ts` 与 provider locator：root/realpath containment、no-follow、inode/dev/nlink 复核、`contextViewSourceMaxBytes()`（constrained memory / 4，最高 512 MiB） | `contextViewSourceMaxBytes`、`CONTEXT_VIEW_READ_FLAGS`、路径 containment |
| Restore 隔离 | `context-view-restore-runner.ts`：独立 child、512 MiB input、32 MiB result/header 校验、timeout、heap/RSS guard、Linux `oom_score_adj=1000`；`context-view-restore.ts` 在 `buildView` 按 `maxBytes` 返回 `too_large` | `contextViewRestoreChild`、heap/RSS/timeout、`oom_score_adj`、`restoredView(...maxBytes)` |
| Claude/Codex/Kimi/Pi/Builtin source | `context-view-service.ts` 前 8 MiB marker scan：`api-request`、`additional_tools`、`llm.request`、Pi request marker；无 marker 报 `no_session` | provider marker 与 captured/native source 判定 |
| Pi/Builtin captured log | `packages/agent/src/pi-request-log.ts`、`packages/agent/src/runner.ts` 写 `pi-requests.jsonl`；`packages/anvil/src/pi/session.ts` 记录 request/media；`context-view-session-source.ts` 暴露 `contextViewRequestLogPath`；attention index 设置 message id，并等待 request capture barrier | `pi-requests`、captured source、media marker、request gap |
| Feature flag/off lifecycle | Web launch identity：`apps/web/src/routes/api/agent-api-keys.ts:183-199`；delivery：`apps/web/src/server/conversations/agent-delivery-features.server.ts:14-24`；Daemon：`agent-feature-sync.ts`、`runtime.ts:281-283,373-382,755-762`。显式 `false` 写 off-since；`undefined`（旧 server 未命名）保持 unknown/既有状态；`forgetLocalAgent` 标记 off；24 h sweep 保留 | `observeFlag`/off-since/24 h grace/`applyServerFlag` |
| Web 入口与 result | `apps/web` owner-only profile action、feature flag、Server Function、Redis pending、Centrifugo result、timeout/error UI；`agent-context-view-result-http.test.ts` 校验 principal | Raft viewer wait、result endpoint、owner/Agent scope |

## 已复核的功能差异与证据缺口

1. **Feature wiring 已完成，但不是 Raft 的实时广播模型。** CoForge 现在有 launch identity gate 和 delivery gate 两路：显式值会同步并在变化时重启 live Agent，delivery 保留并在新 launch 前发送 notice；旧 server 缺字段不会被当成 off。Raft 还提供 `applyServerFlag(enabled, agentIds)`，可立即作用于所有 running agents。CoForge 没有等价的 server-feature broadcast；workspace flag 变化要等下一次 launch 或 delivery。当前没有 runtime integration assertion 证明完整 restart/forget/report 时序，只有 `packages/daemon/test/agent-feature-sync.test.ts` 的行为测试。

2. **错误码没有完全达到 Raft 的可诊断粒度。** Raft bundle 的 `AGENT_CONTEXT_VIEW_FAILURE_REASONS` 含 `offline`、`old_daemon`、`agent_moved`、`expired`、`not_recorded`、`media_removed`、`newer_session_format` 等。当前 daemon query 主要产生 `not_found`、`context_mismatch`、`too_large`、`read_failed` 与 restore failure；Web 主要产生 `offline`、`unsupported`、`timeout`、`unavailable`。protobuf 可承载更多 reason，但尚无证据证明每个状态从 daemon 到 Web 保真传递。

3. **完整链路仍未验证。** 尚无 staging/browser E2E 覆盖：owner action → Server Function → Redis pending → Centrifugo daemon request → real Agent transcript/captured log → child restore → gzip HTTP upload → scoped result acceptance → browser render。现有 Web 测试是纯 principal helper，不能证明真实 auth、transport、Redis 或 provider 行为。因此 Pi/Builtin 的 writer/source 实现已对齐，但真实 provider E2E 仍为 **NOT VERIFIED**。

4. **实现层面的可观测差异。** child 内部会先构造并 JSON encode view 再按 `maxBytes` 拒绝，父 daemon 还会再次序列化检查；这满足 bounded result，但与 Raft 在构造阶段更早截断的内存峰值仍可能不同。Pi capture barrier 对正常 request 已闭合 offset 竞态；provider 超过 5 秒才开始 stream 时仍会走 timeout 兜底，暂列 P2 边界。

## 有意差异（不是缺陷）

- CoForge 使用 protobuf result envelope + daemon bearer + Agent API key；Raft 使用 gzip JSON + Agent API key。CoForge 的双主体校验更强，但 wire 不同，不能声称 1:1。
- CoForge 经 Redis pending/Centrifugo 回传；Raft 直接 POST result endpoint。两者均有约 30 秒 bounded wait。
- CoForge 的 owner-only Web action 与 `agentContextView` product flag 是产品授权选择；Raft bundle 只证明 Computer capability/restore，不规定该 UI policy。

## 发布前待办

- 补一条真实 staging/browser E2E，并保留可复现 artifact。
- 为 running Agent 的 launch/delivery/forget/report 时序补 runtime integration assertion。
- 决定是否需要 server-side `applyServerFlag` 等价广播；若需要，补协议/运行时设计后再实现。
- 明确错误码映射（尤其 `expired`、`agent_moved`、`not_recorded`、`old_daemon`）并补跨层测试。
