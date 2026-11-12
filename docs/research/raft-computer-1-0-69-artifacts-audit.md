# Raft 1.0.69 Artifacts 对齐审计

对照对象：Raft Computer 发布包中 Agent 侧 CLI（`sea/assets/cli.cjs`）的 `artifact` 命令组和
Agent API 路由表。CoForge 一侧读的是 `origin/main` `85f1af1f1`。Raft 的 Web 界面、服务端实现，以及
Manual 里 artifact 那一页的正文都不在二进制里：Manual 由服务端下发，CLI 只放了一个指向它的
提示。所以凡是涉及页面桥接能力（页面能调用哪些 Raft 功能、沙箱拦什么）的结论，标为
**无法从二进制恢复**。

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
| 2 | `read` 显示上次查看以来的变化并推进已读位置 | 没有已读位置 | schema（每个读者一行的已读位置表）、协议 |
| 3 | 评论、回复、图片、@通知、`comments` | 没有 | schema、协议、Web 界面 |
| 4 | `review`（一次提交多条评论，全部成功或全部不发） | 没有 | 依赖 #3 |
| 5 | resolve / reopen 线程 | 没有 | 依赖 #3，Web 界面 |
| 6 | 读到新评论之前不能写（`UNSEEN_CHANGES`） | 没有 | 依赖 #2、#3 |
| 7 | follow / unfollow 与通知 | 没有；只有分享卡片 | schema、投递链路、Web 界面 |
| 8 | 发布检查（无头浏览器 + 双尺寸截图 + 问题列表） | 没有 | 新的服务端任务和浏览器运行环境；协议 |
| 11 | Agent `delete`（只能删自己创建的） | 领域层已允许 Agent 删除自己的（`Artifacts.delete`），但 Agent API 和 CLI 没开放（`docs/agent-cli/artifacts.md`） | 协议、CLI |
| 12 | Agent `move --to server` | 分级已有，但 Agent 不能改（`changeAccess`，task #529）；Agent 的 `share` 只是把卡片发到会话 | 权限规则、协议 |
| 13 | `save`：把附件存成 artifact | 没有 | 协议、Web 界面（附件上的"存为 artifact"） |
| 14 | 页面桥接（页面里的评论按钮、复制、打开链接） | 沙箱完全断网，没有桥接 | **无法从二进制恢复**，需要另找证据 |

已完成第 1 步（`main` `95f39affd`）：原 #0（Agent 推送按文件合并、同文件拒绝）、#1（多文件
pull/push，网页仍限一个 `index.html`）、#9（`download`）、#10（`list --query`/分页）已从上表删除。
操作说明见 [`docs/agent-cli/artifacts.md`](../agent-cli/artifacts.md)。

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
文档的 Web 编辑器、自动保存、离开提醒、冲突界面，人保存时的逐行合并和按文件合并。人能否回到
旧版本（这也是一次写入）尚未定，在第 3 步的设计里一并决定。文档和网页因此不再按"谁能保存"区分，只是入口文件
类型不同（Markdown 或 HTML），与 Raft 一致。Agent 同一文件的冲突按 Raft 处理：拒绝，读最新版
后重做（#0），不再做行级合并。

## 对齐顺序

0. **先有评论，再删编辑。** 删掉编辑后，人唯一的反馈方式就是评论，所以 #3 必须和删除同时
   上线，不能先删。
1. **（已完成）Agent 侧多文件 pull/push、download、list 搜索与分页。**
1b. **沙箱按路径提供多个文件。** 解除网页只能是一个 `index.html` 的限制；改动沙箱的 CSP、访问
   票据和公开链接，属于安全边界，单独出方案给 Frank 批准。
2. **已读位置与 `read` 的"新变化"摘要（#2）。** 只改 Agent 侧，需要一张新表。
3. **评论体系（#3–#7）并删除人工编辑（H）。** 涉及 Web 界面，先按 UI 规则出设计 Artifact，等
   Frank 确认后再写代码；评论上线的同一批次里删除编辑器。
4. **发布检查（#8）。** 需要一个服务端浏览器运行环境，另写方案，说明运维成本。
5. **`save`、`move`（#12、#13）**，最后才讨论 Agent 删除（#11）。

## 证据边界

- `coforge` CLI 不在本机 PATH 上，所以没能读取 `#artifacts` 任务板；git 历史中可见
  `#artifacts:#2`（分享）和 `#artifacts:#24`（沙箱域名）。开工前要在任务板上认领并读回。
- Raft 的 Web 界面、服务端合并细节、通知投递方式只能从路由描述推断，不当作已验证的行为。
