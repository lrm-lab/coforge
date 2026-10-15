# OpenViking 保存群参与 agent 的轨迹审计副本，channel store 保持共享交互唯一权威

群聊应让每个参与 agent 的可采集历史轨迹在 OpenViking 中拥有完整、append-only、可审计的归档副本；副本以稳定引用关联该消息对应的共享 interaction event、segment 与 Interaction DAG。共享 event 的顺序、内容身份及 DAG 的唯一权威仍是 channel interaction store，OpenViking 不成为双主，也不得用镜像状态改写 channel 事实。所有读取继续受 channel capability 与来源 session ACL 的交集约束。该决定只确定权威边界和归档目标；新群的 provision 时机、causal mode 默认、采集闭包、双写可靠性与保留/撤销规则另行决定。
