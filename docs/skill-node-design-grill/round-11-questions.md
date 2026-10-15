# Round 11 问题

每次只问一题。Round 10（Q109–Q125）已定案。本轮只问 Q122-A 留下、尚未绑到 Memory Agent 工具面的那一处。

已定、本轮不再打开：依赖模式查询命中 InfluenceClaim 的 carried_artifact / downstream_effect；邻域只在同一张冻结 Influence View 内沿 Claim 边读时拼装，最多 12 个 block，不落成对象，不跨 HypothesisBridge（Q122-A）。服务端做预召回和初排，主 Memory LLM 决定要不要展开（叙述 #67）。`ov_find` 返回的是 OpenViking 文档引用，没有 `view_revision_id` 或 `claim_id`。`expand_claim_neighborhood` 缺 view 或 claim 时直接失败。

## 本轮用到的术语

- **Memory Agent**：这个 Workspace 里负责翻记忆的群聊成员。它检索、决定要不要把一条 Memory Hint 投给干活的任务 agent。它不发布 skill，也不改 OpenViking 里的原文。
- **服务端预召回**：模型还没动手时，服务端先按这条频道消息找出候选卡片并做初排。模型看到的是这批卡片，不是整库。
- **retrieve**：`HybridRetrievalFacade.retrieve` 这一次调用。它从三份语料收卡片：fork/branch、影响图投影、segment/atom。默认一共最多 12 张。
- **依赖模式查询**：查询形状是「想要的产物 + 想要的效果」，用来对上一条 InfluenceClaim 的签名。例子：想要「发布步骤」，效果是「流量切到绿环境」。
- **Influence View（影响图）**：一张把动作连成影响关系的图。Block 是节点，Claim 是边。
- **冻结 view**：这张图的一份不可变快照。建完就不再改；以后有变化就另起一份 revision。`view_revision_id` 是这份快照的名字，例如 `rev-deploy-2024`。
- **InfluenceBlock（block）**：图上的一个动作块，只属于一个参与者、一段连续动作。例子：「写发布脚本」「切流量」「看错误率」。
- **InfluenceClaim（claim）**：两个 block 之间的一条影响边。`claim_id` 是这条边在该快照里的名字，例如 `edge-bluegreen`。
- **carried_artifact**：这条边上被带下去的产物。例子：发布步骤。
- **downstream_effect**：下游 block 上出现的效果。例子：流量切到绿环境。
- **claim projection（claim 投影卡片）**：给检索看的轻量卡片，带摘要、状态和卡片 id。它不是证据原文，也不是整张影响图。
- **卡片 id**：预召回返回给模型的那张卡片的名字，例如 `claim-card-17`。模型拿它指代「刚才那一张」，不接触内部的 view id 和 claim id。
- **邻域展开**：从一条 claim 的两端出发，只在同一张冻结 view 里沿别的 claim 边往外走。`expand_claim_neighborhood` 就是这个动作。最多 12 个 block。
- **读时拼装**：走出来的「写发布脚本 → 切流量 → 看错误率」只出现在这一次返回里，不另存成一个新对象。
- **HypothesisBridge**：另一类边，表示「这两个东西可能有关、尚未验证」。邻域展开不走这种边，只走同一张冻结 view 里的 InfluenceClaim。
- **ov_find**：Memory Agent 现在用来搜 OpenViking 文档的工具。它返回文档地址和摘录，例如 `viking://resources/runbook.md`。那份结果里没有 view id，也没有 claim id。
- **叙述 #67**：共识里已定的分工：服务端负责预召回和初排；主 Memory LLM 决定要不要展开、要不要下钻。

❓ **Q126** - **邻域展开的调用面**

频道里刚有人说：「这次发布必须蓝绿，先写步骤再切流量。」服务端预召回打到一张 claim projection，卡片 id 是 `claim-card-17`。服务端内部知道它属于冻结 view `rev-deploy-2024`、claim `edge-bluegreen`：上游 block 是「写发布脚本」，下游 block 是「切流量」，再往后还有「看错误率」。这张卡片给模型看的是摘要和卡片 id，不是那两个内部 id。`ov_find` 若单独搜「蓝绿」，返回的是一篇文档引用，例如 `viking://resources/runbook.md` 加一段摘录，里面没有 view id，也没有 claim id。

模型想看这条 claim 前后的 block。展开只在 `rev-deploy-2024` 里沿 claim 边走，从「写发布脚本 → 切流量」再走到「看错误率」，最多 12 个 block。路径只在这次返回里，不写回 registry。

- A. 增加一个展开工具，参数只有这张卡片的 id，例如 `expand(card_id="claim-card-17")`。服务端查出 `rev-deploy-2024` 和 `edge-bluegreen`，返回拼好的路径：写发布脚本 → 切流量 → 看错误率。模型不写 view id 或 claim id。它也可以不调用：摘要里已经写明「切流量」就停在摘要。没有 `claim-card-17` 这种卡片，工具不能展开。`ov_find` 仍只搜文档。
- B. 不增加工具。依赖模式一旦命中 `edge-bluegreen`，`retrieve` 内部就自动把「写发布脚本 → 切流量 → 看错误率」拼进结果。模型还没判断这条 claim 是否值得看，路径已经占了上下文。弱命中也一样：旧笔记里偶然出现「蓝绿」二字，邻域照样展开。
- C. 工具参数就是两个 id，由模型填写，例如 `expand(view_revision_id="rev-deploy-2024", claim_id="edge-bluegreen")`。模型必须自己知道这两个字符串。它若把 `ov_find` 拿到的 `viking://resources/runbook.md` 填进去，或者猜一个 `rev-1`，调用因 view 不存在而失败，邻域不会返回。

➡️ 推荐 A。叙述 #67 把「展不展开」留给主 Memory LLM：摘要已经够用时不展开，不够再用卡片 id 展开。B 把这个决定收回服务端，弱命中也会把整条路径塞进上下文。C 的两个 id 不在现有命中里，模型猜一个就会失败。
