# 用版本化枚举 memory.skill_trajectory_mode = legacy | causal 切换新旧行为

新机制横跨台账、fork 构造、投影、检索、proposal、replay、guidance 与统计；若用多个独立 boolean 表达，会出现"旧 skill 抽取开、新节点关"等无法解释的半启用组合。决定采用单一版本化枚举，作用域为全局默认 → workspace 覆盖 → session 创建时固化；causal 模式统一 gate 全链路。切回 legacy 时保留历史数据与审计、停止新写入/索引消费/聚合；`memory.session_skill_extraction_enabled` 在 legacy 下保持旧语义，在 causal 下由新模式接管。枚举而非 boolean 也为未来第三种模式留位。
