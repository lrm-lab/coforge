# Raft 1.0.69 Artifacts 对齐审计

对照对象：Raft Computer 发布包中 Agent 侧 CLI（`sea/assets/cli.cjs`）的 `artifact` 命令组和
Agent API 路由表。CoForge 一侧读的是 `origin/main` `85f1af1f1`。Raft 的服务端实现和
Manual 里 artifact 那一页的正文不在二进制里（Manual 由服务端下发）。Web 端另用浏览器观察，见文末
"Raft 的 Web 端"一节。

## 版本与来源

`provenance.json`：version `1.0.69`；target `darwin-arm64`；release_id
`865961dd-8f0b-4f64-88cd-1665c3c4611b`；binary SHA-256
`d1ad7fd40b82144af350fef0a67b6078485980c2458f99190642876e87261c67`；gzip SHA-256
`f8ec770530bb2628abb6e2000c09bfd3e5a2935d0780bf3d0e6ce8658e0a8c47`；Node `24.22.1`；观察时间
`2026-11-12T02:52:43.203Z`（source `hands.build updates/check`）。本审计没有引用 1.0.67 和更早版本的
抽取结果。

定位方式：在 `cli.cjs` 里搜 `.command("artifact")` 找到注册函数，再按注册顺序读各命令的
`defineCommand` 定义；用 `agentApiRoute({key:"artifact…"` 读路由描述。

## Raft 的模型

- 一个 artifact 是一组有版本的文件（目录），带一个入口文件。HTML、Markdown、PDF 等都是同一种
  对象；按文件类型区分，没有单独的"文档类型"和"网页类型"。
- 工作方式是 pull/push：`pull` 把某个版本下载到本地目录，并在目录里放一个隐藏状态文件，记录
  这次的 base；`push` 只上传有变化的文件（先按 sha256 和大小报清单，服务端回答缺哪些，上传后
  再提交一次），可以一并删除文件、改入口、标题、描述、改动说明和版本标签。没 pull 过的目录加
  `--target` 就是新建。其他人改的是**别的文件**时自动合并（`merged`）；改了同一个文件则返回
  `BASE_MOVED`。
- **读到新评论之前不能写**：如果有人在 Agent 上次查看之后评论了它要改的文件（或评论了整个
  artifact），push 和 comment 会返回 `UNSEEN_CHANGES`；Agent 看过之后，同一请求再发一次就能通过。
  `read` 会显示"上次查看以来的新版本和新评论"，并推进已读位置。
- 评论：可以针对某个文件（`--path`，服务端还支持 `anchor` 定位到文件内的位置），也可以针对
  整个 artifact，可以回复（`--reply-to`）、附最多 4 张图片，`@name` 会通知对应 Agent。
  `review` 一次提交 1–50 条评论加一段可选总结，要么全部成功，要么一条都不发，每个 Agent 只收到
  一次通知。评论线程可以 `resolve`（带一句说明，作为回复发出）和 `reopen`；在已解决的线程里回复
  会自动重新打开它。
- 关注：push 或评论会自动关注；关注者会收到别人的评论，以及"自己最后改过的文件被别人改了"的
  通知。`unfollow` 之后只有 @提及 还会送达。
- 发布检查：每次 push 了 HTML 版本后，服务端用无头浏览器打开入口页，分别截取桌面（1280×800）
  和手机（390×844）尺寸的截图，并记录控制台错误、加载失败的资源、空白页、手机上横向滚动等问题。
  `check --wait` 等待结果并把截图存到 `.raft-check/`。
- 管理：作者 Agent 可以 `delete`；`move --to server` 可以把 artifact 扩到整个 server 可见，前提是
  管理它的人看得到、也有权这么移动；收回只能由人来做，公开链接也只能由人开启。`save` 把一条消息的
  附件存成 artifact。
- 发现：`list` 支持 `--query` 按标题搜索、`--target`、游标分页；`download` 按字节原样保存单个
  文件（包括评论里的图片）。
- 只有路由、没有 CLI 命令的一项：从旧的独立 artifacts 站点导入（迁移用途，CoForge 不需要）。

## 已对齐

| 能力 | CoForge 证据 | Raft 1.0.69 |
| --- | --- | --- |
| 多文件版本存储 | `apps/web/prisma/models/artifacts.prisma`：`ArtifactVersion`/`ArtifactFile`（path、sha256、size、kind）、`entryPath`、`changedPaths`、`merged` | 版本是一组文件，带入口文件 |
| 内容寻址 blob 与上传授权 | `artifact-files.server.ts` 的 `ArtifactBlobStore`（`inspectMany`、`allowed`）；`ArtifactBlobGrant` | 先报 sha256 清单，再上传缺的部分 |
| 单文件上限 | `ARTIFACT_TEXT_LIMIT` 16 MiB、`ARTIFACT_BINARY_LIMIT` 15 MiB | 16 MiB 文本、15 MiB 二进制 |
| 归属与可见范围分级 | `homeKey`、`access`（conversation/workspace）、`ArtifactAccessEvent`；由人调整，公开链接也只由人开启 | home 是会话或 server；公开只能由人开启 |
| 幂等 | `idempotencyKey`/`requestHash` | review/push 用同一个 key 重放 |

存储层已经是 Raft 的形状。差距主要在**Agent 能用的接口**和**协作功能**上。

## 差距

按"对 Agent 的价值"排序。"触及"一列说明是否会改 schema、Agent API 线协议，或需要 Web 界面。

| # | 能力 | CoForge 现状 | 触及 |
| --- | --- | --- | --- |
| H | 人只评论、不编辑 | 人可在 Web 上编辑 Markdown 文档（编辑器、自动保存、冲突界面，服务端逐行合并）并回到旧版本 | 删除整套人工保存机制；Web 界面；与 #3 衔接 |
| 3 | 评论的 Web 界面、图片、@通知 | Agent 侧已有评论、回复、锚定到文件和行（第 3 步第 1 片）；人还不能评论，评论不带图片，不通知任何人 | Web 界面、投递链路 |
| 5 | 人在 Web 上 resolve / reopen | Agent 侧已有 | Web 界面 |
| 7 | follow / unfollow 与通知 | 没有；只有分享卡片 | schema、投递链路、Web 界面 |
| 8 | 发布检查（无头浏览器 + 双尺寸截图 + 问题列表） | 没有 | 新的服务端任务和浏览器运行环境；协议 |
| 11 | Agent `delete`（只能删自己创建的） | 领域层已允许 Agent 删除自己的（`Artifacts.delete`），但 Agent API 和 CLI 没开放（`docs/agent-cli/artifacts.md`） | 协议、CLI |
| 12 | Agent `move --to server` | 分级已有，但 Agent 不能改（`changeAccess`，task #529）；Agent 的 `share` 只是把卡片发到会话 | 权限规则、协议 |
| 13 | `save`：把附件存成 artifact | 没有 | 协议、Web 界面（附件上的"存为 artifact"） |
| 14 | 页面运行能力：内置图表库、共享文档数据库、页面里的评论按钮、复制、打开链接 | 网页可以从公共 CDN 白名单加载脚本和样式（1b），没有桥接和数据库 | 协议、安全边界（见 Web 端一节） |
| 15 | 每个 artifact 一个独立的源 | 所有网页共用一个沙箱源，`sandbox` 不带 `allow-same-origin` | 通配 DNS/TLS（运维）、安全边界 |

已完成第 1 步（`main` `95f39affd`）：原 #0（Agent 推送按文件合并、同文件拒绝）、#1（多文件
pull/push，网页仍限一个 `index.html`）、#9（`download`）、#10（`list --query`/分页）已从上表删除。
操作说明见 [`docs/agent-cli/artifacts.md`](../agent-cli/artifacts.md)。

之后完成的（都在 `main`）：1b 多文件网页与 CDN 白名单（`527cef127`）；第 2 步已读位置与 `read`
的"新变化"摘要，原 #2（`4c8456cd3`）；第 3 步第 1 片 Agent 侧评论、`review`、resolve/reopen、
读到新评论之前不能写，原 #4、#6（`fb071560d`，见
[`docs/agent-cli/artifact-comments.md`](../agent-cli/artifact-comments.md)）。

## 有意差异（不当作差距）

- **Agent 的 history / revert。** Raft 的 Agent CLI 没有对应命令（`read` 只列最近几个版本，
  `pull --rev` 后再 push 可以达到同样效果）。这两个命令只给 Agent 用，代价小，保留。
- **单一 operation 路由。** CoForge 用 `POST /api/agent/v1/artifacts` 加 `operation` 字段；Raft
  是 REST 风格，每个操作一条路由。功能对齐不要求路由形状一致；但多文件上传需要原始字节，
  JSON 内联 base64 撑不住，所以 #1 需要一条单独的上传路由。
- **Agent 改分级、Agent 合并。** task #529 规定 Agent 不能调整可见范围，task #540 规定 Agent 保存
  必须基于最新版本。Raft 在这两点上都更宽松（#0、#12）。改动属于安全/权限边界，需要 Frank 批准后
  才能改。

## 已定：人只评论、不编辑（Frank，2026-11-12）

Artifact 的内容只由 Agent 写。人在 Web 上看、评论，要改就在评论里 @ Agent。随之删除：Markdown
文档的 Web 编辑器、自动保存、离开提醒、冲突界面，人保存时的逐行合并和按文件合并。人不回到
旧版本（这也是一次写入）：Raft 的 Web 只看版本历史。文档和网页因此不再按"谁能保存"区分，只是入口文件
类型不同（Markdown 或 HTML），与 Raft 一致。Agent 同一文件的冲突按 Raft 处理：拒绝，读最新版
后重做（#0），不再做行级合并。

## 对齐顺序

Frank 2026-11-12 追加：对齐后删掉所有和 Raft 不一致的旧功能，不留兼容（artifacts 还没有用户），
可以大改。

1. **（已完成）** Agent 侧多文件 pull/push、download、list 搜索与分页；1b 沙箱按路径提供多个文件与
   CDN 白名单；第 2 步已读位置；第 3 步第 1 片 Agent 侧评论、review、resolve/reopen、未读评论门槛。
2. **删除不对齐的功能（进行中，分支 `chore/artifacts-raft-only`，未进 `main`）。**
   - 已提交：人在 Web 上只看不编辑（删编辑器、自动保存、冲突界面、`docDraft`、人保存的服务端
     函数）；Agent 只剩 pull/push，`push --target` 新建；删除 Agent 的 create、share、history、
     revert，单段文本 push，`kind` 列（类型由入口文件决定），逐行合并与 `diff` 依赖，
     `revertedFrom`，人作为发布者的列；四个删列迁移。全量 test/check/build 已通过。
   - 审查后的修复（进行中）：新建合成一个事务；push 拒绝超过 2 MiB 的 Markdown/HTML 入口；
     删除权限为管理员或作者 Agent 的主人；查看页只在 Markdown 时读正文；沙箱子资源不算权限；
     入口类型一个函数；实时事件去掉 `publisher`；去掉只转发的一层；分享改成单个 artifact。
   - 收尾：重跑全量检查，私有环境（独立 Postgres/Redis，Web 8788，不碰共享开发库）跑
     `e2e-artifact-page/share/send/public-link` 和 `artifact-sandbox-browser`，再推 `main`。
3. **第 2 片：给 Agent 的通知与 follow/unfollow（#7）。** 按 Raft `artifactAgentNotice`：
   理由 mentioned、subscribed、your_file_changed、your_comment_resolved。
   - 投递沿用应用事件的做法：每个 artifact 和 Agent 一个专用会话（`directKey` 字符串，不对
     artifacts 建外键），一条真 Message 加一行 delivery（`reason`），由 artifacts 模块之外的代码
     经端口写入（在 `artifact-composition.server.ts` 接线），与评论同一事务写、提交后推送，重放
     不重发。正文只指向 artifact（标题、理由、条数、`coforge artifact comments <id>`），评论内容
     不离开 `artifact_*` 表。
   - 新表 `artifact_follows`（含 `unfollowedAt`，同 `ThreadFollow`）；push 和评论自动关注，
     显式 unfollow 后只有 @ 还送达。每次写入每个 Agent 一条；不通知自己；逐个复查读权限。
   - SDK/CLI：`follow`、`unfollow`；comment/review/resolve 回答 `notified`、`notNotified`
     （@ 到的人在第 3 片前列为未通知）。
   - 先确认：旧 daemon 对新 `reason` 和会话类型的处理；Agent 用什么命令读这个会话、什么清除
     delivery；所有枚举会话 kind 的地方（`APP_EVENTS_KIND` 的各处）。
4. **第 3 片：人在 Web 上评论。** 先按 UI 规则做设计 Artifact 给 Frank 确认：评论开关、选元素
   锚定、行/文件锚定、线程、resolve/reopen、@ 提示"会通知谁"、图片（最多 4 张）。人不回到
   旧版本（Raft 的 Web 只看版本历史），版本历史只读。
5. **之后的差距，需要 Frank 批准或涉及运维：** 发布检查（#8，服务端无头浏览器）；每个 artifact
   一个独立源（#15，通配 DNS/TLS）；页面数据库、图表库与桥接（#14）；Agent `save`、`move`、
   `delete`（#11–#13，权限规则）；入口支持 PDF 等其他类型（现在只认 Markdown/HTML）。

## 证据边界

- `coforge` CLI 不在本机 PATH 上，所以没能读取 `#artifacts` 任务板；git 历史中可见
  `#artifacts:#2`（分享）和 `#artifacts:#24`（沙箱域名）。开工前要在任务板上认领并读回。
- Raft 的服务端合并细节、通知投递方式只能从路由描述和 Web 端文案推断，不当作已验证的行为。

## Raft 的 Web 端（app.raft.build，2026-11-12 用浏览器观察）

观察方式：用已登录的浏览器打开 Artifacts 页和一个 HTML artifact，记录页面结构、iframe 属性和网络响应头；
又读了 Web 端公开的静态脚本（`ArtifactFrame-*.js` 等）里的说明文字。只做设计对照，不复制代码。

- **画廊**（`/s/<server>/artifacts`）：按标题搜索；按对话、作者、"和我有关"筛选；排序（最近打开）；
  网格/列表两种视图。卡片显示预览（HTML 显示占位图标，Markdown 显示正文开头）、标题、版本号、
  作者、可见范围图标、"打开于 N 小时前"。
- **查看页**（`/artifacts/<id>`）：标题、版本号、在场信息（"1 人在看 · 你在看 · 2 人看过最新版"）；
  右侧是评论开关、页面内查找、复制链接、更多操作。更多操作菜单：复制嵌入代码、发到对话、谁能看、
  重命名、版本历史、文件、下载、关注、删除。**没有编辑入口**：人只看和评论。
- **评论**：打开评论模式后，底部出现"选元素"工具，评论锚定在页面的某个元素上。
- **页面怎么运行**：iframe 加载 `https://w-<artifact uuid>.w.raftusercontent.com/...`，每个 artifact
  一个独立的源；`sandbox="allow-scripts allow-same-origin"`，所以页面有自己真实的源（可以用存储）。
  流程是先加载一个"门"页（`/__porthole/door/…?ticket=…`，只运行一段按 hash 固定的脚本），再进入
  `/_raft/open?ticket=…` 显示页面。票据经过签名，写明 artifact、版本、查看者、源、过期时间和一次性随机数。
- **页面的 CSP**：脚本和样式允许内联，外加一份公共 CDN 白名单（cdnjs、jsdelivr、unpkg、esm.sh、
  tailwind、jquery、plotly；字体允许 Google Fonts）；artifact 自己的文件在 `/__porthole/f/<封存令牌>/`
  下，`connect-src` 只允许这些 CDN 和自己的文件；`frame-src 'none'`、`webrtc 'block'`、
  `form-action 'none'`。封存令牌到期前由页面通过 `/__porthole/renew` 续期。
- **页面能用的能力**：内置 chart.js 和 d3（`/__porthole/lib/…`）；共享文档数据库（`db.get/set/query`）；
  上传资源；通过宿主打开链接、复制文本、打开评论框。被沙箱拦下的事（弹窗、表单提交、下载、
  `mailto:`、设备、service worker、`document.write`）都有给作者看的说明。
- **评论**（来自 Web 端中文文案）：评论可以锚定在整个 artifact、文本文件的某行或某几行、CSV 的
  某行、页面上某个元素（带引用摘录）；原文改了显示"原文已改动"，当前版本里没有则显示"此版本中没有"。
  输入框会显示"会通知：某某"；`@` 列出能看到这个 artifact 的人和 Agent，有人数上限，`@` 看不到的人会被拒绝。
  一条评论最多 4 张图（PNG/JPEG/WebP/GIF），没发出去的保存为草稿。线程可以回复、编辑（标"已编辑"）、
  删除、解决、重新打开；已解决的单独成组；可以按某次评审筛选；可以加载更早的评论。
  卡片和总览显示"上次查看后有 N 条新评论"，依赖第 2 步的已读位置。
