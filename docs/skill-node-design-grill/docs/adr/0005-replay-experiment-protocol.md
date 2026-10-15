# replay 是 daemon 判定、隔离执行的配对实验，不做生产环境重放

"不同 skill 产生不同 guidance"需要可复现对照，而重放工具调用会真实触碰生产资源。决定：可否 replay 由 coforge daemon 创建 job 时按七步判定（来源完整有权限、初始状态可重建、工具版本可执行、逐工具副作用隔离、临时最小权限凭据、非确定性可控、预算合规），不接受调用方自称；任一不过即持久化 ineligible job 并转入 guidance append 路径。可行时由一次性隔离 worker（copy-on-write 快照、默认禁网、无生产凭据）执行，预算为每次诊断 ≤3 个 skill revision ×（1 guidance 分支 + 1 同条件无 guidance 配对基线）、每分支 16k token / 25 工具调用 / 10 分钟、全局并发 2。正向效用仅认相对配对基线的可观测改善。
