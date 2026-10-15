# 新建群从创建时起固化为 Causal 模式

要兑现每个群参与 agent 的历史轨迹从首条事件起即可归档到 OpenViking 的承诺，群创建必须为其群 session 显式固化 `memory.skill_trajectory_mode = causal`，而非继承当时的全局或 workspace 默认值。这样 AO 记录、群聊 interaction event 的参与者轨迹和后续因果能力从群建立起具备一致语义；创建后再切换或首次检索时才启用都会遗漏开端历史。此决定不改变非群 session 的默认优先级，也不规定既有 Legacy 群的迁移、回填或切换策略。
