# 首次登录设置向导

与 Raft 对齐的功能（[来源与优先级](sources-and-priority.md)）：Raft 在创建服务器之后，于真实的工作区之上弹出「Set up your server」，依次连接电脑、创建 Cindy、问角色、交接。CoForge 的对应物是这个向导；元素与操作取自 Raft，用 CoForge 现有的组件和文案实现，不另做视觉设计。

## 谁会看到

- 只有首次登录时为本人新建的个人 Workspace：`FirstSignIn` 在创建 Workspace 的同一个事务里写 `WorkspaceMemberPreference.onboardingPendingSince`。
- 不会有向导的情形：邀请或加入链接进入的 Workspace，`/workspaces/new` 和切换器里新建的 Workspace，已有成员（不需要回填，字段为 NULL 即没有向导），重复提交姓名（已有 Workspace 时不再写入）。
- 向导显示的唯一条件是当前成员在当前 Workspace 的 `onboardingPendingSince` 不为空。Workspace 路由的 loader 从成员设置那一行（`loadMemberWorkspaceSettings`，与面板标签顺序是同一次读取）得到 `setupPending`；只有处于向导中的成员才再取 `loadOnboardingWizard`，布局据此懒加载向导组件。其他成员不多做任何读取，也不会加载它。
- 完成或跳过后清空该字段；换设备、刷新都不会再出现。

## 外观

- 向导是 Workspace 布局里的模态框（`components/ui/modal`，`DialogHeader`，`components/ui/dialog-actions`），盖在真实的 Workspace 之上；与 Raft 一样宽（`max-w-[55rem]`），手机上占满宽度。Escape 和点击外部都不能关闭，出口只有完成和跳过。
- 三个有边框的区域（`WizardShell`）：头部是小字「设置你的工作区」、四段进度（官方 `ProgressBarBase`，每步一段）、步骤标题和一句说明这一步做什么的话；正文有固定高度，步骤之间尺寸不跳；页脚左侧是安静的「跳过设置」，右侧是这一步的动作。
- 没有 Raft 页脚左侧的「切换工作区 · 工作区设置」：向导只出现在成员唯一的个人 Workspace 里，没有可切换的目标，而设置页同样会被这个模态框盖住，所以不放这两个链接。
- 助手信息和第一步要用的电脑列表随 loader 一起到达（`OnboardingWizard.state`；电脑列表是 `listComputerConnections` 的窄读取，与电脑页的等待连接共用，不经过那个还读 Agent、升级和云镜像的 `listComputers`），数据不再单独请求，模态框在页面水合后立即显示（先于第 2 步的选择器）；只有第 2 步的运行时选择器在第一步显示之后才加载。电脑列表只在第 1 步且还有东西会变化时才每 2.5 秒重读：选了云电脑但未上线，或本地电脑未连接、未检测到可用运行时；设备批准只在显示安装命令时查询，答案为「是」后停止。进入向导时的默认选择（有本地电脑选本地，否则有云电脑选云）只在打开时定一次，之后出现的电脑不会改动成员的选择。安装命令里的地址取浏览器当前的 `location.origin`。

## 四个步骤

1. **连接电脑**（`computer`）。云电脑和自己的电脑始终是两张 `ComputerTypeOption` 卡片。首次登录已经启动了账号的默认云电脑，所以云电脑只显示状态，不放创建按钮；没有云集群的部署里云电脑卡片置灰并说明原因。云电脑卡片自己显示实时状态。选自己的电脑时：已有的本地电脑是可选的行，带真实状态（在线 / 离线，与电脑页同一个状态点和文案），另有「连接另一台电脑」；没有或要连接新的，就在下面直接显示安装面板（系统切换、可复制的命令，`ComputerInstallCommand`）和 Raft 式的实时检查（`ProgressSteps`）：已授权（成员批准了设备登录，`loadDeviceApproval`；Daemon 轮询后授权记录变为 `consumed`，也算已批准）、`<机器名>` 已连接、检测到运行时。每一行为真时打勾，正在等的那一行是转圈，其后是空圈（`localConnectionChecks`）。云电脑只要存在即可继续；本地电脑要在线且检测到至少一个可用运行时。
2. **你的助手**（`assistant`）。Raft 的两栏：左侧是着色面板里的助手卡片（助手自己的 mascot、名字、一行角色说明），右侧是运行时、供应商、模型选择（`AgentRuntimeFields`，与新建 Agent 对话框同一套），页脚左侧有「不是你要用的电脑？重新选择」，回到第 1 步。云电脑默认 Pi，本地电脑默认检测到的最优运行时（Pi、Claude Code，其余按运行时选择器的顺序，见 `defaultRuntimeProvider`）。这一步配置已有的助手，不创建新 Agent：`WorkspaceAssistants.configure` 把它绑到所选电脑并保存运行时。手机上两栏上下叠放。
3. **你主要做什么？**（`role`）。六张带图标的卡片（与电脑卡片同样式、没有说明文字）：工程师、设计师、产品经理、运营 / 市场、研究、创始人 / 管理者（`PERSON_ROLES`，一处定义，数据库 `CHECK` 与之一致）。可跳过。答案存成 `UserPreference.role`，只给助手读，界面上不再显示。
4. **交给助手**（`handoff`）。居中的助手卡片，说明助手会在私信里问好；选了角色则说明会按角色提议一支起步团队。「开始」。

## 完成与跳过

- 「开始」和「跳过设置」调用同一个服务端动作 `OnboardingWizard.complete`：先在一个事务里保存角色（仅「开始」且选了角色时）并清空 `onboardingPendingSince`，再启动助手，返回它的私信会话 id。只有真正清空了标记的那次调用才保存角色和启动；重复调用不再保存角色；标记已清空而助手仍从未运行（上一次的启动在提交后丢了），重复调用会补发启动，已启动的只返回会话 id。
- 客户端随后导航到该私信（聊天路由会把它记为该 Workspace 最近的会话）并让布局重新加载，向导即消失；失败只弹出提示。
- 「跳过设置」按默认值完成：云电脑、默认运行时、不存角色；已在第 2 步保存的电脑和运行时保留。
- 角色必须属于封闭集合，经 `UserPreferences.setRole` 校验，集合之外报 `INVALID_INPUT`。

## 助手何时才自我介绍

- 向导未完成期间，成员的平台助手照常准备好（Agent、会话、私信、绑定默认云电脑），但不自我介绍：`AgentIntroduction.promptFor` 在生成介绍时才读 `setupFacts`（只对仍欠介绍的平台助手），标记未清空时不带介绍也不结算；读取失败时同样不带介绍，由 Daemon 的 ready 恢复重试。
- 被挂起的启动，即成员没有要求的那些：`startAssistantIfOwed`（首次登录、创建 Workspace、加入链接、启动回填、侧栏加载共用，经 `promptFor` 无介绍而不发布），以及 `AgentControl.recover`（Daemon ready 恢复和消息投递被拒后的唤醒）开头的 `AgentIntroduction.holdsStart`：标记未清空或读不到时直接返回，不 `begin`、不写 `controlState`。否则 Daemon 上线会启动助手，它不再是「从未运行」，第 2 步就不能再改绑。
- 不挂起的是成员自己发起的启动、重启和配置变更（向导的模态框盖住了界面，向导期间发不出）。助手是私有的，其他人的消息到不了它。
- 完成后第一次启动带上介绍。`setupFacts` 同时带回 `UserPreference.role`，所以恢复重试也有：角色已知就提议为该角色组一支起步 Agent 团队、成员同意后才创建；未知就问在做什么；永远不再问角色。
- 第 2 步只改库，不启动助手：从未运行过的平台助手（`NEVER_RAN`）可以直接重新绑定，不需要迁移原生会话；已经运行过的被拒绝（`workspace-assistant-already-started`），换电脑走 Agent 个人资料里的迁移。

## 验证

- 纯函数 `features/onboarding/onboarding-wizard-plan.ts`：`test/onboarding-wizard-plan.test.ts`。
- 服务端：`test/onboarding-wizard.integration.ts`、`test/workspace-assistant-configure.integration.ts`、`test/workspace-assistant-onboarding.integration.ts`、`test/agent-introduction.test.ts`、`test/workspace-member-preferences.integration.ts`。
- 浏览器：`test/onboarding-wizard.e2e.ts`（首次登录、走完或跳过、落到助手私信）。
- 手工清单见 [UI 手工验证场景](../agents/ui-manual-checks.md)。
