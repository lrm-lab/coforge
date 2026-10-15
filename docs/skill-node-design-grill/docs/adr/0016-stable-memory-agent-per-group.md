# 每个新建群立即加入一名稳定的 Memory Agent

> 2026-10-13 起，「每个新建群各自 provision 一名独立 identity」由 CONSENSUS `default-memory-agent/Q217–Q235` 取代。一个 Workspace 只有一名 Memory Agent。下文保留为当时的决定。不按 task 或 thread 临时创建仍然有效。未新建 ADR。

每个群在创建时、首条事件之前，必须 provision 恰好一名具有独立 identity 与 session 的 Memory Agent，并将其作为持续存在的群成员。该 agent 从首条群事件起接收消息，按既定 retrieval profile 自主监听，并将自身可采集轨迹归档到 OpenViking；它不按 task 或 thread 创建新的实例。稳定 identity 让 ACL、审计、重启恢复、Hint 节流与归档归属均有单一主体。此决定不规定既有群的补建方式、agent 移除/替换语义、资源预算或用户静默策略。
