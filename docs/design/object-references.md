# 在正文和详情里引用一个对象

任务标签（task #456）、任务详情弹窗（task #464）、消息里的任务卡片（task #449 第 3 步）和项目页（task #462）都按这一页的原则做。调研只用官方文档、更新日志和官方配图，时间是 2026-11-03。每条结论都附了来源；查不到一手资料的，写在最后的「没能核实」里。

## 原则

1. **标题说明是什么，编号只用来定位。** 编号用灰色小字放在标题后面，或者只出现在悬停卡片里。只有编号、没有标题的写法，只出现在很紧凑的地方（GitHub 普通的 `#26`、Linear 侧栏的关系列表），而且 GitHub 一放进列表就会展开成「标题 + 状态」。参考：Linear 的提及选择器、GitHub 列表里的引用、Slack Work Object、Atlassian 智能链接。
2. **颜色只给状态。** 状态图标（或状态小块）是唯一有颜色的地方，引用本身用中性色，不加彩色描边。Linear 只给状态图标上色；Atlassian 只有状态小块是实心色；Slack Work Object 的状态颜色只有红、黄、绿、灰、蓝五种，而且只用在状态上。
3. **所在位置只在和读者所在的地方不同时才写。** GitHub 同仓库写 `#26`，跨仓库写 `owner/repo#26`。Slack 的卡片只写外部来源（「in Jira」），因为 Slack 本身就是上下文。
4. **正文里的引用和文字一样高，详情在悬停或点击之后。** GitHub：链接 → 悬停卡片 → 页面。Atlassian：URL、行内、卡片、嵌入四种形态，外加悬停卡片。Notion：提及 → 悬停预览 → 页面。Slack：预览 → 侧边面板。
5. **看不到的对象只给最少的信息。** Notion 把标题换成「No access」，不显示「Untitled」，也不换成别的版式。Linear 私有团队的链接在 Slack 里从不展开。Slack 把敏感内容放进需要登录的侧边面板。CoForge 里，看不到的任务只写「无权查看的任务」，不带编号、状态和群名。
6. **左边一个图标说明类型或状态，这个对象出现在哪里都用同一个图标。** Linear 的状态图标同时出现在选择器、侧栏和子任务行；GitHub 的打开/关闭图标同时出现在任务列表、子任务行和「Parent:」标签。
7. **详情的头部分两层：上面一行写在哪里和编号，下面是大标题；状态和操作放在旁边，不挤进标题。** Linear 是 `Engineering › ENG-116` 加标题；Jira 是 `空间 / 父项 / KEY` 加标题，状态在右上角。
8. **子项的每一行和正文里的引用是同一套结构，区块标题上写进度。** Linear 在「Sub-issues 0/1」下面列 `[状态] [编号] [标题] … 标签`；GitHub 在「Sub-issues [0 of 2]」下面列 `[图标] 标题 #6`。
9. **头部明确给出回去的路，不只靠浏览器后退或 Esc。** GitHub 每个子 issue 的头部都有「Parent: 标题」；Jira 的面包屑里有父项；Linear 和 Notion 用面包屑。Esc 只是在这之上再多一个快捷方式。

## 各产品怎么做

| 产品 | 编号 | 标题 | 状态 | 所在位置 | 看不到时 | 悬停 |
|---|---|---|---|---|---|---|
| Linear | 带团队前缀（`ENG-123`），选择器里是灰色、放在前面 | 选择器和 Slack 预览里有；紧凑的关系列表里没有 | 只给状态图标上色 | 包含在编号前缀里；详情页面包屑写 `Engineering › ENG-116` | 私有团队的链接在 Slack 里不展开 | 文档没写；Slack 预览里有状态、负责人 |
| GitHub | `#26`；跨仓库写 `owner/repo#26` | 普通引用不显示标题；放进列表后显示成 `[图标] 标题 #3`，`#3` 是灰色 | 列表里是彩色状态图标；悬停卡片里是彩色状态小块 | 只有跨仓库时才写 `owner/repo` | 文档没写 | 状态、仓库、标题加灰色编号、正文摘录、标签、参与人 |
| Notion | 页面提及不显示编号 | 只显示标题，页面改名后提及会跟着变 | 页面提及没有状态 | 提及里不写，靠目标页面的面包屑 | 标题显示成「No access」 | 应用链接有悬停预览 |
| Slack Work Object | 标题下面一行灰字 `WEB-2341 in Jira` | 加粗标题 | 状态小块只有 5 种颜色 | 只写外部来源 | 敏感内容放进需要登录的侧边面板；受限时只显示一部分 | 悬停出现工具栏，点击打开侧边面板 |
| Atlassian 智能链接 | `MC-17:` 写在标题前面 | 行内显示标题 | 状态小块单独放在链接后面，是全大写的 | 行内不写；卡片形态会写空间名 | 只显示完整的 URL（来源是工单，不是官方文档） | 标题、更新时间、摘录、操作 |

| 详情页 | 头部 | 属性 | 子项的一行 | 怎么回去 |
|---|---|---|---|---|
| Linear | `团队 › ENG-116`，右边是 `2 / 86` 上下切换 | 右侧栏：状态、优先级、负责人、标签、周期、项目 | `[状态] [灰色编号] [标题] … 标签 头像`，区块标题写「Sub-issues 0/1」 | 点面包屑 |
| GitHub | 标题加灰色 `#3`，下一行是状态小块和「Parent: 标题」 | — | `[展开] [状态] 标题 #6 [进度]` | 点 Parent 标签 |
| Jira | `空间 / 父项 / [类型] KEY`，标题，右上角是状态下拉 | 右侧「Details」：标签在上、值在下 | — | 点面包屑里的父项 |
| Notion | 面包屑，前面有前进/后退箭头 | 页面属性在标题下面 | 父项可以展开成子项 | 点面包屑 |

## 来源

- Linear：[Editor](https://linear.app/docs/editor)、[Slack 集成](https://linear.app/docs/slack)、[Issue properties](https://linear.app/docs/issue-property)、[Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)、[2023-07-06 更新日志（面包屑）](https://linear.app/changelog/2023-07-06-slack-sync)
- GitHub：[Autolinked references](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)、[Hovercards](https://github.blog/changelog/2018-06-19-hovercards/)、[Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)、[GitHub for Slack](https://github.com/integrations/slack)
- Notion：[Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)、[2021-12-23 更新（No access）](https://www.notion.com/releases/2021-12-23)、[Link previews](https://www.notion.com/help/guides/notion-api-link-previews-feature)
- Slack：[Unfurling links](https://docs.slack.dev/messaging/unfurling-links-in-messages)、[Work Objects](https://docs.slack.dev/messaging/work-objects-overview)、[Share links in Slack](https://slack.com/help/articles/204399343-Share-links-in-Slack)
- Atlassian：[Insert links and anchors](https://support.atlassian.com/confluence-cloud/docs/insert-links-and-anchors/)、[Confluence + Jira](https://www.atlassian.com/software/confluence/resources/guides/extend-functionality/confluence-jira)、[Smart Links in Jira](https://support.atlassian.com/jira-software-cloud/docs/smart-links-for-your-timeline/)

## 没能核实

- Linear：`@ENG-123` 在已发出的评论里是什么样子、有没有悬停卡片，都没有官方图片或文字；peek 的文档页已经 404。
- GitHub：悬停卡片只有 2018 年的动图；没有权限的人看到的 issue 引用是什么样子，找不到一手资料。
- Notion：没有行内 `@页面` 的官方图片；普通页面提及有没有悬停预览，不确定。
- Slack：受限 Work Object 上「申请访问」按钮的实际文字，只出现在文档的示例数据里。
- Atlassian：Jira 智能链接「申请访问」的状态没有官方文档或图片。
- Asana 没有调研。
