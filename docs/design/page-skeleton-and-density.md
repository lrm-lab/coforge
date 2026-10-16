# 8. 页面骨架与密度

参照 Linear、Notion 和 Untitled UI 自带的 sidebar-navigation。

- 应用侧栏有两种形态：展开（220px，顶部 Logo 加名称和收起按钮，下面是工作区行、图标加文字的导航行、无边框用户卡；手机抽屉用同一套）和收缩的窄栏（3.5rem / 56px，只有图标，顶部是展开按钮）。窄栏不画图标下的文字，设置里也没有「侧栏显示文字」开关。悬停或键盘聚焦时，名字出现在图标右侧的提示里，提示从图标的点击区域起算，不从整栏右缘起算；链接本身带 `aria-label`，当前页用 `aria-current="page"`。5rem 在文字去掉之后仍在图标两侧留空，提示就被推离图标。栏宽现在只包住 2.5rem 的图标和一圈 2.75rem 的点击热区。桌面默认展开，收起状态记在本机（`features/settings/sidebar-expanded.ts`）。展开形态按设计稿，是 `sidebar-simple.tsx` 复制后的 CoForge 自有组件，窄栏同理。侧栏底色用 CoForge 的 `--color-sidebar`（亮 `#f8f7fe`，暗色为紫黑渐变），右侧一条 `border-secondary`。这是唯一有意偏离官方（官方侧栏是 `bg-primary`）的地方，目的是品牌辨识。
- 桌面端内容区是一张 `bg-primary` 的圆角（`rounded-xl`）整卡，上、右、下各与侧栏背景留 8px，左边紧贴侧栏；侧栏和这圈留白共用一层渐变背景（`--sidebar-gradient`），侧栏本身没有边线。页面根元素用 `h-full` 填满这张卡，不用 `h-svh`。由多个面板组成的页面（目前只有对话页：列表和对话）在根元素上标 `data-panel-cards`，整卡随之变透明，每个面板各自是一张圆角卡，卡间距 8px。页面内的多个面板（列表 + 详情、对话 + thread）之间只用 1px `border-secondary` 分隔。
- 整卡之内**不用**卡片岛屿：页面级面板没有 `rounded`、没有 `border` 包边、没有 gutter、没有阴影。卡片只用于内容里真正独立的对象（一个附件、一条运行时），以及[第 9 节](field-display.md)的事实列表分组。设置页（语言和地区、偏好设置）按设计稿例外：每组一个图标加大写小标题，组内每个设置或每个保存单元一张卡片（`rounded-xl border border-secondary shadow-xs`），开关放行尾，存在本设备的设置在卡片里注明「仅保存在此设备上」。成员页的「系统频道」分区（仅所有者/管理员）不用卡片：分区标题同「待处理邀请」，「隐藏 #general 频道」要按「保存」才生效，用勾选框放行尾，下方放「保存」。
- 侧栏可拖拽：默认 280，范围 240 到 360。手柄不可见，热区 6 到 8px 压在分隔线上，hover 或拖拽时显示 2px 品牌色线。
- 页头高度 48px（`h-12`），标题 `text-lg font-semibold`，右侧放主操作。侧栏 logo 行同高，logo 和页面标题共一条基线。页头下方的二级操作区（筛选、工具条）高 44px（`h-11`），里面的控件一律 36px（`size="sm"`），不另加上下内边距。会话页不另起标签带：Chat / Tasks / Files 是官方横向 `underline` 标签（`size="md"`，图标 + 文字），在页头这一行居中、压在页头底线上，激活标签的品牌色下划线替代它下面那段底线；对话区（按容器宽度，不按视口）窄于 `@2xl` 时标签掉到标题下面第二行（`components/layout/tabbed-header.tsx`）。频道页头在标题旁放所属项目：文件夹图标加项目名的白底细边胶囊（对照频道页头稿），链到项目页；没有项目则不放，描述仍留在标题旁。右侧搜索按钮旁是成员头像叠放，最多 4 张，其余收成浅紫 +N，再跟一枚虚线加号（仅频道成员、且频道未归档时出现）用来邀请。这排用官方 xs 圆头像（1.5rem，`styles.css` 里把 `size-6` 收成正圆），叠放 `-space-x-1`、描边 `ring-[1.5px]`，每张脸的按钮用 `inline-flex` 居中，照片和首字母落在同一条中线，不用消息流那枚 2.25rem × 2.5rem 的圆角矩形；+N 和邀请加号同样用 xs。低于 md 的手机不放头像和 +N，邀请加号仍在。频道名和项目胶囊挤在一起时胶囊先缩（`shrink-[999]`，最窄留住文件夹图标），标题后缩。点头像或 +N 打开成员名单，点加号打开添加成员。这两处和设置面板里的成员条读同一份成员数据。Activity 的 All / Unread / Mentions 同样放在页头居中（`PageHeader` 的 `tabs`），Unread 和 Mentions 标签带未读卡片数，为 0 不显示。Agent 面板（右侧资料面板）的顶栏只有头像和名字，状态由头像角上的点表示，描述在 Profile 标签里；顶栏下是官方横向 `underline` 标签（`size="sm"`，图标 + 文字，默认顺序 Profile、Activity、Reminders、Workspace），压在标签带自己的底线上，窄屏时标签横向滚动、底线不动。
- 操作区光学对齐：无边框的按钮排（`color="tertiary"` 的 `Button` 标签带、`ButtonUtility` 图标簇）让按钮**内容**（图标或文字）对齐面板沟槽，用负 margin 抵消按钮内边距——`size="sm"` 按钮是 `px-3`，左缘用 `-ml-3`；`ButtonUtility` 是 `p-1.5`，用 `-ml-1.5`，右缘镜像用 `-mr-1.5`。激活态的浅色药丸盒超出沟槽那 12px 是有意的（Linear、Notion 同）。有边框的盒式控件（Input、Select、`ButtonGroup`、`button-border` 标签组、卡片）反过来：盒边缘对齐沟槽，**不加**负 margin。
- 可交互元素 hover 一律显示小手：`styles.css` 的基础层已让 `button:not(:disabled)` 全局 `cursor: pointer`，链接走浏览器默认；非 button 的自定义触发器（`role="button"`、hover popover 触发器、可点 chip）必须自己显式补 `cursor: pointer`。禁用态用 `cursor: not-allowed`（官方 Button 自带）。不要用 `cursor: default` 暗示可点。

## 密度

- 字号按[第 14 节](typography.md)的八档和使用场景选：`text-sm`（14px）用于小标题、预览行、用户名和侧栏导航，`text-md`（16px）用于标题和正文，`text-xs`（12px）用于代码和时间信息。对话消息正文跟随设置 → Message font size（12/14/16px，默认 14px，见 `message-markdown.css`）。
- 列表行高 40 到 48px，字段行高 44px，表格行高 44px。例外：私聊行带预览行时是两行，头像 48px 加 p-2，约 64px（按设计稿）。
- section 之间 `border-secondary`，section 内边距 `py-6 px-8`。
- 页面能一屏看完的，不要让它两屏。

### 聊天消息流

用户确认参考 Slack 消息流：采用保留头像的 [Clean 布局](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed)，不是隐藏头像的 Compact 模式或左右气泡。
消息、附件和任务引用沿正文列左对齐；同一发送者五分钟内的连续消息合组，跨日期不合组。
间距（设计稿，task #99）：带发送者名字的消息，内容距 hover 背景四边各 12px；同一发送者的连续消息只留左右 12px，上下仍紧贴（距上一行 4px）。两段发送者之间内容到内容 32px，手机（`md` 以下）收紧为 24px（task #118：32px 在窄屏短消息之间读成一条空带）。hover 背景是不透明的 `#F7F8FB`（`--color-message-hover`，设计指定；`#E0E5F1` 只用于边框和分割线，不铺底），圆角 8px（`rounded-lg`），右侧操作图标无背景浮层，距 hover 背景右上各 12px。日期和未读分割线距上下内容各 16px，线色 `border-secondary`，日期标签带同色描边。
短日期分隔与时分时间戳承担辅助信息，已有 thread 才在消息下显示回复摘要。
[Slack thread 示例](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions)是按需消息操作的参考；Web 的触摸适配保留无描边的消息菜单入口，不能只靠 hover。
输入区与附件排版参考 [Untitled Messaging examples](https://www.untitledui.com/react/components/messaging)，继续组合已安装的官方基础组件，不复制受 PRO 授权限制的源码。
输入框参考 Slack：一个圆角框，文字在上，待发送的附件在文字下面，最底下一条工具栏（左边“＋”添加附件，右边“作为任务”复选框和发送）；聚焦时边框加深，不用彩色光圈；主窗格提示文字写会话名（“发消息到 #general”）。附件是有实线边框和轻阴影的卡片（内描边会被图片盖住，不用）：图片是 4rem 缩略图，其他文件带类型图标、文件名和大小；上传中变淡并在底部显示进度条，失败边框变红；点开看详情、下载、重试或删除，不另放叉号。
“作为任务”是发送按钮左边一直显示的复选框（同 Raft 的 As Task），勾上再发：这条消息照常发出、带着全部附件，同时就是一个任务；成功发送后自动取消勾选。
