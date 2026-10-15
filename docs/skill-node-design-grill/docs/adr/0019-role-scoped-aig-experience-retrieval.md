# AIG 图角色复用角色化检索深模块，不直接调用有状态群 Memory Agent

Builder、Critic、Refiner、Reader 需要复用与 Memory Agent 相同的多 corpus 检索能力，但不得直接调用那名持有稳定群身份、活 session 与可变 MemoryTaskState 的群 Memory Agent。直接调用会把 Memory 的权限、预算、查询顺序与历史偏差带入 pinned AIG run，破坏重放、Critic 独立性和 phase gate。决定让所有调用者使用同一 role-scoped retrieval interface，并显式提交 `{role, principal, scope, pinned_watermark, search_plan, budget}`。

返回信封必须机器级分离 `current_evidence_refs[]` 与 `analogical_prior_cards[]`。只有当前 watermark 内、按调用 principal 可见的 AO/Segment/raw evidence 能支持或反驳当前 Claim；历史 frozen AIG/IG projection、Fork、Branch、Guidance、future/imagined branch 与跨树相似 Fork 均只是 prior，必须保留来源 task/run、状态、synthetic 标记、ACL 和 rank provenance。

角色 profile：Builder 先只用当前证据从空图形成 initial draft，保存 hash 后才可用 prior 挑战遗漏，任何修改仍须当前证据；Critic 进行独立检索以寻找反例/错误构图模式，但 violation 必须落到当前证据；Refiner 不开放历史类比检索，只能读取 violation 涉及的当前证据并做最小编辑；Reader 先闭卷核验 frozen graph，只有 unresolved 项可按需取 prior，最终 supports/contradicts 仍只能引用当前证据。Raw AO 权限采用 `required_capability + on_demand_selected`，绝不在 session 启动时全文注入：Reader/Critic 必须能读取 selected current raw AO，Builder 按需，Refiner 仅 violation-local，Memory/Diagnosis summary-first 后显式升级；读取失败只能输出 insufficient/redacted。群 Memory Agent 是该接口的另一个调用者，不是其他角色的状态或权限代理。
