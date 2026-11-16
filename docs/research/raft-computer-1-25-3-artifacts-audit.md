# Raft 1.25.3 Artifacts 对齐审计

对照对象：Raft Computer 发布包中 Agent 侧 CLI 的 `artifact` 命令组和 Agent API 路由表，加上
app.raft.build 的 Web 端（浏览器只读观察）。只做设计对照，不复制代码、标识符或文案。

## 版本与来源

- 发布包：version `1.25.3`，release_id `8fbc6c7e-087c-4c3c-b85a-479a96a1cd00`，binary SHA-256
  `abe7b218b285b606c0f61e8a37abd454e4b1d06d764cb7d4f957e0d8bd357f28`，观察时间
  `2026-11-16T07:02:04Z`；用 `scripts/reference-computer/extract.ts` 抽取。
- 与 1.0.69 相比，17 个 `artifact` 子命令的参数和路由没有变化；差别在服务端行为和 Web 端。
- Web 端：2026-11-16 用已登录的浏览器只读观察画廊、查看页、更多菜单、版本、文件、改名、删除、
  在场信息、评论模式和手机宽度；没有创建、修改或评论任何内容。

## Raft 的模型

- 一个 artifact 是一组有版本的文件，带一个入口文件；类型由入口文件决定（html、markdown、text、
  csv、image、pdf、video、other）。
- 归属（home）是一个对话；可见范围是 home 的成员、整个 server，或任何持有链接的人。Agent 只能把
  自己写的 artifact 移到 server（`move --to server`）；收窄和公开链接由人操作。作者 Agent 可以删除。
- pull/push 按 sha256 清单上传。别人改的是别的文件时自动合并；改了同一个文件返回 `BASE_MOVED`。
  内容和设置都没变的 push 不产生版本（`unchanged`）；只改标题时改名，不产生版本（`titleChanged`）；
  同一请求重放回答 `replayed`。
- 读到新评论之前不能写（`UNSEEN_CHANGES`）：拒绝里带上没看过的评论和版本，展示过的算已读，同一
  请求再发一次即可；`read` 会把它展示的内容标为已读。
- 评论锚定到整个 artifact、文件、行或页面元素，可回复、resolve/reopen、带最多 4 张图；`review`
  一次提交多条，每个 Agent 只收一次通知。
- 关注与通知：写入即关注；理由 mentioned、subscribed、your_file_changed、your_comment_resolved，
  改名也通知（`renamed{by,from,to}`）。
- 每个网页 artifact 在自己的源上运行，用一次性票据进入，页面通过桥接调用宿主（打开链接、复制、
  查找、共享数据库、资源库）。

## 对齐状态

| 能力 | CoForge 状态 |
| --- | --- |
| 多文件版本、按文件合并、`BASE_MOVED` | 已对齐 |
| 可见范围：home 成员 / Workspace / 公开链接；Agent `move`、`delete` | 已对齐（撤销了 task #20 的"全员可读"） |
| `unchanged`、`titleChanged`、`replayed`；入口可为任意文件（`entryKind`） | 已对齐 |
| 未读门槛：拒绝带内容、展示即已读、resolve 也受门槛 | 已对齐 |
| 按 id、链接、页面源链接或精确标题引用；标题重名返回候选 | 已对齐 |
| 关注与通知（含改名），通知走 `@app.system.artifacts` | 已对齐 |
| 评论图片（最多 4 张，去元数据）、`download --image` | 已对齐 |
| `save`：把消息附件存为 artifact | 已对齐 |
| 每 artifact 独立源、一次性票据、页面桥接、页面内查找 | 已对齐 |
| 页面共享数据库（`db`）与资源库（`assets`） | 已对齐 |
| 查看页头部、更多菜单、版本切换、文件面板、下载 zip、改名、关注、在场信息、发布横幅 | 已对齐 |
| 画廊：搜索、对话/作者筛选、"和我有关"、排序、网格/列表、角标、分页 | 已对齐 |
| 消息里的 artifact 卡片 | 已对齐 |
| 每 Agent 每分钟 60 次写入限速 | 已对齐 |

## 尚未对齐

- **人在 Web 上评论**：评论开关、选元素锚定、行/文件锚定、线程、草稿、"会通知谁"、人的通知。
  下一片要做；Agent 侧评论已经完整。
- **HTML 页面里的元素锚定（annotate）**：随人在 Web 上评论一起做。
- **非入口 HTML 文件和 PDF 的预览**：现在显示"无法预览"并提供下载。

## 有意差异

- **发布检查**（push 后用无头浏览器截图并报告问题）：不做（Frank，2026-11-16）。Agent 没有
  `check` 命令，push 不返回 `check`。
- **频道公告 artifact**（`--announcement`）：CoForge 没有频道公告，不做。
- **从旧 artifacts 站点导入**：Raft 的迁移用途，CoForge 不需要。
- **人只评论、不编辑**（Frank，2026-11-12）：内容只由 Agent 写；人能改的只有标题和可见范围。
- **谁能改名**：Raft 资料未说明。CoForge 只允许能管理分享的人（作者 Agent 的主人或 Workspace
  owner/admin），参照 Claude artifact"只有所有者和编辑者能改"（Frank，2026-11-16）。
- **Agent 读不到页面共享数据**：Raft 发布包里没有对应接口，CoForge 也不提供。

## Raft 未说明、由 CoForge 自定的细节

- 未读展示的条数（完整 5 条、8000 字符，另加 5 条摘录）；链接里的版本参数名（`version` 或 `v`）。
- 页面源的子域名形如 `a-<uuid>`（前缀区分 artifact 页面，与同域下的其他主机名分开）。
- 在场信息用 Redis 有序集合，45 秒过期、20 秒心跳；画廊"没看过最新版"按人的查看位置计算。
- 页面数据上限：单文档 64 KiB，单 artifact 5 MiB / 10,000 个文档；资源每个 10 MiB、最多 200 个、
  合计 256 MiB；SVG、HTML、脚本和样式不能作为资源。

## 已知安全缺口

- Chrome 157 尚未执行 CSP 的 `webrtc 'block'`，页面可以经 `about:blank` 子框架发出 STUN 请求。
  Raft 用同一条指令，处境相同；e2e 固定了这一点，`apps/web/src/server/artifacts/AGENTS.md` 有记录。

## 证据边界

- Raft 服务端的合并、通知投递和改名触发文案只能从路由描述、类型结构和 Web 端文案推断。
- Web 端观察只读，评论流程只看到了界面，没有发出评论。
