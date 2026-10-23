# 5.2 侧栏「完成设置」清单

展开侧栏（含手机抽屉）里、用户卡正上方的一张小卡片，带新成员依次完成最常用的设置。收缩的窄栏不显示。代码在 `apps/web/src/features/onboarding/`（界面、查询、关闭）和 `apps/web/src/server/onboarding/`（`SetupChecklist`，只读已有的行，不存步骤进度，只存关闭）。

## 步骤与完成条件

按下表顺序列出；每一行都能点，点哪行就执行哪行的动作，卡片底部的按钮以第一条未完成步骤的名字为文字，点它就执行这一步。步骤不要求顺序完成。

| 步骤 | 完成条件 | 动作 |
| --- | --- | --- |
| 和通用助手打个招呼（`assistant`） | 本人在自己的通用助手私聊里发过至少一条消息 | 打开该私聊 |
| 连接 GitHub（`github`） | 数据库里的 GitHub 连接状态是 `connected`；`pending_installation`、`reauthorize` 不算 | 直接发起 OAuth（按状态选连接、重新授权或安装），完成后回到 Workspace 首页；已连接时打开设置页的集成一节 |
| 创建你的第一个 Agent（`agent`） | 本人在该 Workspace 有未删除、非系统的 Agent | 打开成员页的新建 Agent 对话框（`/members?setup=create-agent`） |
| 给 Agent 派一个任务（`task`） | 该 Workspace 有任务，创建者是本人，负责人是 Agent | 打开任务页 |
| 连接自己的电脑（`computer`） | 本人名下有未删除的本地电脑（`kind = local`） | 打开电脑页 |
| 邀请协作者（`invite`） | 该 Workspace 有不止一位成员 | 打开成员页的邀请对话框（`/members?setup=invite`） |

不适用的步骤整行不出现，进度分母随之变小：

- 部署没有配置 GitHub：没有「连接 GitHub」。
- 角色不能创建 Agent 或邀请成员（仅所有者和管理员可以）：没有「创建你的第一个 Agent」和「邀请协作者」。

GitHub 状态只读数据库快照（`connection.overview`），从不在加载清单时访问 GitHub；读取失败时这一步算未完成，不影响其余步骤。

## 显示与关闭

- 加载中或加载失败时什么都不画，不显示编造的「0 / N」。
- 右上角 ✕ 对本人在该 Workspace 关闭清单，存在服务端的 `WorkspaceMemberPreference.setupChecklistDismissedAt`（按成员、按 Workspace；重复关闭保留第一次的时间），所以换设备、换浏览器也不会再出现。关闭后读取接口直接返回 `dismissed: true` 和空的步骤列表，不再查询各步骤，卡片也不再轮询。点击 ✕ 时界面先乐观隐藏，请求失败则恢复并提示。
- 卡片的外观沿用 Untitled UI 侧栏的官方 featured card（带进度条的那张）：`bg-secondary` 圆角卡、`text-sm font-semibold` 标题、官方 `CloseButton` 压在右上角、官方 `ProgressBar`（进度文字在右侧）；步骤行在卡片里就地组合（React Aria 按钮加 `@untitledui/icons`）：官方的 Progress steps 是 PRO 组件，而 `ui/progress-steps.tsx` 只展示进度、不能点，这里每一行都要能点。进度条外包一层带名字的 `role="group"`。
- 在用户眼前完成最后一步时，卡片变成带勾的「设置完成」，关掉后不再出现；打开页面时若已全部完成则什么都不显示。
- 还有未完成的步骤时，每次切换页面、窗口重新获得焦点时都重新读取，可见的标签页里另外每 30 秒读一次，所以在这里或别的标签页做完的步骤很快就会打勾；全部完成后不再读取。
- 卡片是带名字的 `<section>`，进度条是真正的 `progressbar`（值是「N / 总数」），每行是按钮，✕ 有 `aria-label`，颜色全部用语义 token，深浅色都适用。

## 对话框的链接

成员页的新建 Agent 和邀请对话框是否打开由地址栏的 `setup` 参数决定（同设置页的头像选择器 `avatar=choose`）：按钮写入参数，关闭时清除；当前角色不能用的对话框保持关闭。

## GitHub 回跳

从清单发起的 GitHub 授权要回到首页而不是设置页。回跳 Cookie 在 Workspace 的 slug 后可带一个封闭的目标：`<slug>` 回设置页（默认），`<slug>:home` 回 `/w/<slug>`；除 `home` 外的任何值都按设置页处理，不接受任意路径。授权失败时仍回设置页，由那里的提示说明原因。

## 创建 Workspace 后的「连接 GitHub」一步

新建 Workspace 之后先到全页的 `/w/<slug>/connect-github`（不带侧栏，沿用 `/welcome` 的 `AuthSplitLayout`），问一次要不要连接 GitHub。路由文件 `w.$workspaceSlug_.connect-github.tsx` 在 Workspace 布局之外，所以在自己的 `beforeLoad` 里用 `openWorkspace()` 确认本人是成员（不是成员则 404，旧 slug 跳到当前 slug）。可选查询参数 `next` 是站内路径（经 `safeReturnTo` 校验，非站内一律忽略），默认 Workspace 首页。

- 部署没有配置 GitHub，或本人已是 `connected`：页面不显示，直接跳到 `next`。
- 其余状态显示主按钮：`disconnected` 连接、`pending_installation`「选择仓库」、`reauthorize`「重新授权」，都带 `returnTo: "home"`，授权完成回到 Workspace 首页；发起失败在页内提示，按钮可再点。
- 「暂时跳过」直接去 `next`，不存任何东西；侧栏清单的 GitHub 一行继续提醒。
- 入口共三个，都在创建 Workspace 之后：首次登录的 `/welcome`（仅当没有 `returnTo`，或 `returnTo` 就是 `/` 或语言根（`/en`、`/zh-CN`）；邀请或加入链接带的 `returnTo` 照旧）、`/workspaces/new`、Workspace 切换器的新建对话框（后两者共用 `useCreateAndOpenWorkspace`）。加入已有 Workspace 不经过这一步。

读取 GitHub 状态失败时当作不需要询问，直接跳到 `next`，不阻塞进入新 Workspace。`next` 指向任何 `connect-github` 页时（会循环）退回 Workspace 首页。这一页不调用 `markShownWorkspace`：Workspace 布局在第一次加载 `/w/<slug>` 时才打开它。

判断逻辑在纯函数 `features/onboarding/github-step.ts`（`githubStepPlan`），单元测试 `test/github-step.test.ts`；浏览器 E2E 是 `test/workspace-github-step.e2e.ts`。
