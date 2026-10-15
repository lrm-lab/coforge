# Round 4（griller: kiro / gpt-5.6-sol，经中间人转达）

设计树状态：除本轮三个明确选择外，前序协议已闭合；AO 台账全覆盖、节点稀疏化已定。本轮先补全 replay 判定流程，再收束节点预算、因果上下文与想象分支表示。

## 回答：daemon 如何判定可否 replay

daemon 创建 replay job 时，先把待诊断的失败轨迹定位到其 node_id、所属 session/archive/workspace，以及对应的 AO 台账区间。它收集并冻结以下输入：

- **初始输入**：原始用户输入、系统/agent 配置、固定随机种子、时钟与环境变量。
- **工作区快照**：对应 git commit、文件快照或容器镜像的 manifest 与 hash；必须能实际取得并挂载。
- **AO 台账**：每个 action 的工具名、参数（脱敏后）、工具版本、调用顺序、observation synopsis、大结果的外置引用。
- **工具注册表**：每个工具的当前/历史版本、参数 schema、副作用分类（纯计算、只读、本地写入、外部写入、网络访问、需凭据）、可否 mock、允许的 sandbox 策略。
- **重放资源**：每个工具所需的 mock fixture、模拟服务、白名单地址、测试数据库/队列、临时凭据或"不需要凭据"声明。
- **安全与权限**：调用者对源 session/workspace 的读取权限，daemon 对快照、mock 和测试资源的执行权限。

然后按以下顺序检查，任一项不满足即判 ineligible、不启动 worker：

1. **来源完整且有权限**：源 node、AO 台账、原始输入和所需 artifact 引用都存在且 daemon 有权读取。
2. **初始状态可重建**：workspace 的 commit/文件快照、依赖镜像和必要配置都可取得，hash 与记录一致。
3. **工具版本可执行**：AO 台账中每个工具调用都能在注册表中找到兼容实现；工具升级导致旧行为无法复现则不可 replay，除非有经批准的兼容适配器。
4. **逐工具检查副作用覆盖**：纯计算/只读工具须能在 sandbox 运行；读外部系统的工具须有 mock/fixture 或明确可安全隔离；本地写入工具只写 copy-on-write 工作区；网络/数据库/队列/邮件/支付等外部副作用工具**必须全部**有 mock 或显式白名单隔离端点——任何会触达生产目标的调用直接判不可 replay。
5. **凭据可安全满足**：须用临时、最小权限、仅测试环境的凭据或完全由 mock 覆盖；只能拿生产凭据、拿不到凭据、或权限过大，均不可 replay。
6. **非确定性可控制**：随机数、时间、并发输入、第三方返回须有固定 seed、录制结果或 mock。
7. **资源与策略可接受**：执行计划符合 token、工具调用、墙钟和并发预算，所有网络/文件系统规则可由 sandbox 强制执行。

每个请求都会创建一条持久化 replay job 记录（即使不可执行），元数据至少含：eligibility（eligible/ineligible）、blocking_checks[]、missing_artifacts[]、逐工具副作用分类与 mock/白名单覆盖表、workspace snapshot hash、工具版本清单、凭据模式（mock/temporary/none，绝不保存密钥本身）、sandbox policy 版本、最终重放约束。ineligible job 不进 worker 队列，走已定的 append structured-guidance event 路径；之后补齐资源可基于同一 job 重新判定。

**请确认**：上述"逐 AO 工具覆盖检查，任一未隔离副作用、不可得快照、缺 mock/安全凭据即不可 replay"的机制，是否作为 Q21 的固定判定协议？

❓ **Q22** - **每个 archive 最多留几个七段快照节点？**
(a) 已决：AO 台账不设上限，所有 action-observation pair 都会留下廉价记录。现在只决定昂贵的七段快照节点。请直接选一个数字：每个 archive 最多留 1、2、3、4 还是其他数字个节点？超出时是否按下面顺序留最重要的节点：**不可逆变更 > 失败纠正 > 诊断/计划转折 > 其他**？（例如上限 3，就只留排最前的 3 个，其余仍在 AO 台账中，但没有七段快照节点。）

➡️ 推荐答案：**3 个**，并接受上述保留顺序。

---

❓ **Q23** - **causal context 在何时选定，能否引用未来 AO pair？**
每个稀疏 trajectory node 要引用一组 AO 台账记录作为"这个动作当时依据了什么"。二选一：
- **A. commit 时固定**：extractor 在节点写入时选出 causal_context_ao_ids，写入后不可改；只能指向该节点之前已发生的 AO pair。
- **B. 诊断时回溯**：平时不固定或可改；诊断时再从整条轨迹中挑"看起来相关"的 AO pair，可能包含节点之后发生的内容。

A 的好处是历史因果不被后来的结果倒灌改写；B 的好处是诊断时信息更多，但"当时为什么这么做"与"后来发现什么"会混在一起。

➡️ 推荐答案：**A，并强制只引用严格更早的 AO pair。**诊断时可另外检索后续证据，但不得改写 node 已固定的 causal context。

---

❓ **Q24** - **想象分支是否要生成想象出的 observation？**
- **A. 完整 AO 序列**：生成"如果做了这个动作，可能观察到什么"的合成 observation；branch 检索文本可包含动作、预期结果和失败模式，诊断价值高，但成本更高，且每条 observation 必须明确标为"想象"。
- **B. 仅动作序列**：只生成"接下来可以做什么"，不写预期 observation；成本低，但 branch 检索文本更像无结果的计划，难以比较不同路线为何更可能成功或失败。

请选择 A 或 B，并确认想象内容绝不与真实 observation 混淆。

➡️ 推荐答案：**A**。想象分支保存短小、带 synthetic 标记的完整 AO 序列；branch 检索文本用"父状态 + 动作 + 合成预期结果/失败模式 + guidance 摘要"，始终低于真实 branch 的默认排序。

---

**设计树已走完，无剩余 frontier。**（Q22、Q23、Q24 答复并确认 daemon 判定协议后，整个 grill 结束。）
