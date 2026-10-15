# G5：评测并发席位结构（CONSENSUS 总账 #58/#69/#100）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景与设计依据
设计契约：每次 Memory→Diagnosis→Memory 评测迭代统一最多并发 5 个一次性子 agent（InteractionPathWorker、sub-diagnosis worker、explorer 共用槽位）；独立诊断并发 ≤3；阶段屏障复用统一 5-worker 槽（Build→Critic/Refine→Freeze→Reader 不重叠，总预算不因复用扩张）。目前 openviking/session/evaluation_orchestrator.py 没有任何席位结构（评审 Minor #19 点名）。

## 目标契约
1. 在 evaluation_orchestrator.py 新增 WorkerSeatPool（或同等结构）：
   - total=5，显式 acquire/release（支持 context manager）；池满时 acquire 返回结构化失败（NoSeatError，携带当前持有者清单），不阻塞等待；
   - 独立诊断子池上限 3：reserve_diagnosis(n) 校验 n≤3 且 ≤ 当前总空闲，违规同样结构化失败；
   - 席位持有可查询（holder、获取时间、用途标签），供审计；acquire/release 必须配对，提供 held_snapshot() 供泄漏检测。
2. EvaluationOrchestrator 构造可选注入 seats（默认自建 total=5）；迁移进入诊断相关 phase 的守卫增加"诊断批量 ≤3"校验（配合 F2e 的迁移证据守卫，不取代）。
3. 纯库级确定性实现，不需要真并发原语；时间戳一律用已注入的 clock（该模块已有 clock）。

## 允许修改的文件
openviking/session/evaluation_orchestrator.py；tests/test_evaluation_orchestrator.py。

## 验收
新测试：5 上限拒绝第 6 个；诊断批量 4 被拒；release 后可再取；held_snapshot 反映持有与释放；现有测试全绿。
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_evaluation_orchestrator.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件；不得放宽 F2e 迁移证据守卫。
