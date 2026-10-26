# UI manual verification

以下场景承接已移除的组件渲染单测，由 Frank 在真实浏览器中验证；未勾选表示尚未验证。纯逻辑测试与浏览器 e2e 继续保留。括号中的文件名用于对照原用例的界面范围，并非仍需运行的测试。

## 准备与记录

- [ ] 准备 owner/admin、普通成员、Agent 创建者及无对应权限的查看者；数据包含在线/离线、停止/运行、已删除/未绑定 Computer 的 Agent，以及多种运行时和用量状态。
- [ ] 下列界面至少检查中英文、桌面与窄屏、light/dark；可交互控件同时检查键盘和触摸。记录页面、账号权限、浏览器、viewport、主题、结果与发现的问题。

## Agent 列表与私聊摘要

原范围：`agent-list-row.test.tsx`、`agent-peer-dms-section.test.tsx`。

- [ ] 在忙碌/关注 Agent 弹出列表检查头像：已有 mascot 时显示该 mascot 的动态头像；无 mascot（包括已删除、App bot、尚未知晓的 mascot）时保留静态头像，不错误套用其他角色。
- [ ] Profile 的 Agent 间私聊区域无卡片时整块隐藏；有卡片时显示对方名称、@handle 和最后一句摘要，发言者根据最后一条消息来自对方还是当前 Agent 正确切换。
- [ ] 仅受限私聊显示暂停标识，普通私聊不显示；这些只读卡片不提供打开、关注或回复操作。

## Agent Profile 与错误信息

原范围：`agent-profile-tab.test.tsx`、`agent-error-banner.test.tsx`。

- [ ] 普通成员看到只读 Profile，无编辑铅笔和 Actions；有管理权限者看到允许的编辑项与 Actions。头像、名称、状态和 @handle 只在面板头部出现，不在 tab 内重复。
- [ ] Actions 随运行状态切换 Start/Stop：已停止 Agent 提供 Start；运行中的 Agent 提供对应停止操作。操作可用性与当前权限一致。
- [ ] 无用量查看权限或不支持 Usage 的运行时只显示普通 Runtime 标签；有权限且支持 Usage 时显示带运行时名称的 Usage 入口，不向其他查看者暴露用量。
- [ ] 未读取 context、没有 Computer 或已删除 Agent 不提供不可用的 context 卡片；有权限且具备用量/context 数据时可打开用量卡片、健康状态和 context 页脚。
- [ ] Runtime pill 不塞入 context 数字或单独 context 行：普通、超限及已钳制的数据状态都保持 pill 简洁，详细信息在卡片里看。
- [ ] 有管理权限且提供运行时编辑入口时显示 Runtime config 铅笔，即使 Agent 尚未绑定 Computer；非管理者或没有编辑入口时不显示。
- [ ] 无可见性修改权限时显示 Public/Private 纯文本，无铅笔；创建者或获授权 owner/admin 可看到当前可见性并修改；未获授权的私有 Agent 仍只显示 Private。
- [ ] Runtime config 每条事实独占一行；Mode 根据配置正确显示 Default、Fast 或 Not applied，不重复标题或挤在相邻值内。
- [ ] Agent 运行错误横幅对查看者都显示错误本身；只有具备 Activity 入口权限者看到复制诊断和查看日志操作，其他成员不出现这两项。

## Agent 运行时配置与 Skills

原范围：`agent-runtime-config-dialog.test.tsx`、`agent-skills-panel.test.tsx`。

- [ ] 未绑定 Computer 的 Agent 打开设置时显示 Computer 选择器和设置标题；已绑定 Agent 的编辑面板显示对应标题、Provider、Model 与 Save，Reasoning 等目录返回后再按能力出现。
- [ ] 未改配置时 Save 禁用；保存过程中显示保存中文案并禁用；保存失败在面板内显示 alert，不只靠 toast 告知。
- [ ] 非 owner 不显示环境变量 disclosure；owner 的环境区默认收起。owner 环境查询尚未加载时显示加载状态，Save 保持不可用。
- [ ] Pi Provider 提供 Configured、DeepSeek、OpenRouter 等预期选项，不额外插入重复提示；保存过的内置 provider 已有凭证时显示保留 key 的提示，不强迫重填。
- [ ] Pi 保存的是内置列表外的 provider（例如 zai）时，重新打开仍能看到并选中该 provider，不因打开面板而悄悄改为其他选项。
- [ ] Skills 首次加载显示标题和加载行；加载完成后的 global/workspace 数量与内容一致，加载失败时检查错误文案和可用的 Retry 入口，而不是以服务端静态 markup 代替加载验证。

## Computer 与 Runtime Usage

原范围：`runtime-usage-credits.test.tsx` 中的渲染用例；窗口命名、入口源码及 Public toggle 的非渲染检查继续自动测试。

- [ ] Kiro credit 计划标题行显示计划名和剩余百分比，进度条下显示已用/限额；有 overage 时跟随用量显示，金额使用当前 locale 的数值格式。
- [ ] 用量扫描/刷新过程中 Refresh 仍可聚焦、可按，刷新状态不把焦点踢回页面。验证鼠标、键盘及触摸打开弹出层后的焦点行为。
- [ ] Runtime chip 显示该运行时标志、名称和圆形状态点；状态点的可访问名称与弹出层状态 badge 一致。
- [ ] Usage 弹出层顶部显示版本与 Refresh，计划与正常状态 badge 顺序清楚；Computer 页面和 Profile 的入口都可通过按下打开。
- [ ] reader 报错、无数据和无响应时均显示一致的失败状态；需要登录时显示 Not signed in，不把失败或未登录误报为正常配额。
- [ ] 配额达到限额时显示 Used up，并保留重置时间；不同计划/窗口的剩余比例和重置提示与实际数据一致。
- [ ] 已退出运行时仍保留 Refresh 以便重新探测，但不显示账号与用量，调用方允许的登录等操作在内容末尾；有账号查看权限但无 Usage 权限者仍能看到允许展示的已掩码账号。
- [ ] Codex credits 信息只在确有内容时作为账号行的说明显示；检查有限、无限、缺失等状态，不残留其他账号的额度信息。
- [ ] Public toggle 更新过程中仍可操作并保留当前弹出层/焦点，重复提交由处理流程防护，不因禁用控件意外关闭正在查看的内容。

## App bot

原范围：`app-bot-ui.test.tsx` 的渲染用例；bot 管理权限判断继续自动测试。

- [ ] App 声明 bot 且功能开启时，owner/admin 在未授权状态看到 Enable Bot；授权后看到 Bot enabled、Disable Bot 和当前状态。普通成员看到状态与联系管理者的说明，不提供启停控制。
- [ ] 功能关闭或 App 未声明 bot 时，不显示 bot 安装控制；App 编辑页未保存前开关不可用并说明先保存，已保存后可管理声明，关闭时明确告知会撤销已有授权。
- [ ] Installed App 卡片只在 bot 已获授权时显示 Bot enabled；未授权或没有 bot 时不显示该标识。
- [ ] bot 的 Profile 显示 App 名、Bot badge、App 管理归属、@handle 与运行状态；不显示 Computer、Runtime、Model、Restart 或名称编辑等普通 Agent 管理项。无论从面板还是独立 bot Profile 入口看到的信息一致。

## 会话、消息与文件

原范围：`channel-add-members-actions.test.tsx`、`channel-header-people.test.tsx`、`conversation-files-card.test.tsx`、`conversation-thread-root.test.tsx`、`mention-token-render.test.tsx` 的渲染用例。

- [ ] 添加成员对话框：无添加权限者只见 Cancel；有权限且选中成员时见带人数的 Add 和 Cancel；未选成员时 Add 不可提交，Cancel 始终可用。
- [ ] 频道头部桌面头像最多显示前四人，其余折叠为正确的 +N；检查小尺寸头像、重叠间距和轮廓不被挤坏。无邀请权限时无添加入口；无人且无邀请入口时整组隐藏。
- [ ] 可预览文件卡片点击名称、缩略图和卡片其他区域均打开同一个预览；图片卡片同样有效。下载/更多操作独立于预览触发器，点击下载不打开预览；不可预览文件不提供伪预览入口。
- [ ] 线程根消息使用正常消息行，可复制、打开 reaction picker 并显示已有 reactions；根消息不再提供进入自身线程的入口，回复仍各自显示在其下方。
- [ ] 消息有存储 mention 行时，人或 Agent token 显示为正确的 @mention 芯片，包括提及当前查看者；无法解析时退化为字面文本，不造出虚假的芯片。
- [ ] 会话内的 Task 引用显示对应状态 badge；已有 Task 且允许打开时可操作，未知编号或会话外引用保持普通文字，不跳到其他会话的 Task。
- [ ] 能打开 Profile 的人/Agent mention 作为行内 hover-card 触发器，并验证键盘和触摸入口；没有可打开 Profile 的 mention 仅保留非交互高亮。

## 头像与 Settings

原范围：`avatar-breadcrumb.test.tsx`、`avatar-sticker.test.tsx`。

- [ ] 动态 mascot 与静态 mascot 都保持白边贴纸外观：图形可略超出头像框、不被裁切、不垫背景；普通人物照片仍按头像容器裁切，不套用贴纸效果。
- [ ] 打开 Account 的头像选择器后，页面头部按 Account → Change avatar 显示路径，只有一个主标题；选择器内容本身不重复面包屑或 Profile 标题。关闭选择器后恢复普通 Account 标题，无残留路径。
- [ ] 其他不带 breadcrumb 的页面只显示自身标题；检查桌面/窄屏时面包屑与标题的显示顺序和截断，不能重复或挤掉选择器内容。

## 侧栏与基础控件

原范围：`sidebar-nav-icons.test.tsx` 的渲染用例、`spinner.test.tsx`；CSS token 检查继续自动测试。

- [ ] 折叠 rail、展开侧栏和移动 drawer 的普通图标使用 nav-fg，当前项使用 nav-fg-current；不退回品牌紫或旧 caption 灰。检查对应描边（rail 2.4、展开栏 2）与 light/dark 对比度。
- [ ] 折叠 rail 保持 3.5rem 图标列，按钮目标为 2.75rem；名称不作为可见文字挤入窄列，但可访问名称、当前页标识与 Tooltip 正确。无横向溢出，Tooltip 靠近图标。
- [ ] Spinner 使用继承当前颜色的装饰性 SVG，不向辅助技术重复播报；允许动画时旋转，系统开启 reduced motion 时停止旋转。
