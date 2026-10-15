# LearnedSkill 五基准评测进度（cursor agent 执行，编排者只读）
2026-09-26T07:17:39Z | launch | cursor-agent 已派发，简报 eval/brief-e2e-eval.md
2026-09-26T07:47:42Z | worktree | detached worktree cursor-lsk-eval at 4a7f2890 (feat/learned-skill already checked out in the main clone)
2026-09-26T07:47:42Z | harness | benchmark ported onto group-memory; runner numeric coercion and host-Pi injection skip applied; OpenViking account path removed
2026-09-26T07:47:42Z | infra | coforge_lsk_eval migrated (86); redis DB 1/2; vite 18889; centrifugo 18001; no second OpenViking container
2026-09-26T07:47:42Z | loop | lsk-loop-demo-979e5d89: 5 episodes distilled, 8 insights, 1 active skill revision, insight offer published
2026-09-26T07:49:53Z | harness | eval daemon readiness probe uses /api/jwks because the dev HTML shell redirects to /en/messages and returns 500
2026-09-26T07:56:58Z | smoke-pcm | conv-26 q0 mechanism=ok citations=16 judge=WRONG (sessions 15-19 only); grade path works; directed ask has no offer row
2026-09-26T08:02:27Z | smoke-evo | first warm episode aborted at 240s: memory handed off with send_channel_message @task, offer row 0, task agent was in bash and had not posted; rerun with 600s abort
2026-09-26T08:16:43Z | smoke-evo | 1883_C warm wrote a 1622-char task answer with offer row 0; old settle held the episode to abort and labeled it leak/timeout
2026-09-26T08:16:43Z | harness | episode ends when the task channel message is quiet for settleMs; leak only when the task agent never posts
2026-09-26T08:16:43Z | repro | wrote eval/REPRO.md and eval/REPORT.md; uncommitted patch already at eval/uncommitted-coforge-lsk.patch
2026-09-26T08:16:43Z | full-evo-warm | started eval/bin/lsk-evo-warm.sh eval id evo-lsk1 workspace e76f35f7, 268 episodes one family, log eval/evo-warm-lsk1.log
2026-09-26T17:36:12Z | resume | evo-lsk1 warm still alive (pid 2465551/2465552), 178/268, 0 quota errors, not restarted
2026-09-26T17:36:12Z | loop-evidence | warm ws distilled=178 insights=50 skills=1 offers=0; models use @task channel handoff not memory_offer
2026-09-26T17:36:12Z | load | baseline evol/sb mostly drained; sf3/sf4 watchdogs still up; no new full LSK batch started
2026-09-26T17:36:12Z | scripts | wrote eval/bin remaining runners + after-warm watcher (starts cold after warm summary)
2026-09-26T17:37:23Z | evo-warm-tick | attempts=178/268 last=abc393_a no_offer
2026-09-26T18:07:23Z | evo-warm-tick | attempts=183/268 last=3423 no_offer
2026-09-26T18:37:23Z | evo-warm-tick | attempts=189/268 last=abc320_c no_offer
2026-09-26T19:07:23Z | evo-warm-tick | attempts=195/268 last=abc327_d leak
2026-09-26T19:37:23Z | evo-warm-tick | attempts=207/268 last=abc353_a no_offer
2026-09-26T20:07:23Z | evo-warm-tick | attempts=216/268 last=abc359_e leak
2026-09-26T20:37:23Z | evo-warm-tick | attempts=223/268 last=abc367_a no_offer
2026-09-26T21:07:24Z | evo-warm-tick | attempts=231/268 last=abc375_b no_offer
2026-09-26T21:37:24Z | evo-warm-tick | attempts=238/268 last=abc381_b no_offer
2026-09-26T22:07:24Z | evo-warm-tick | attempts=248/268 last=abc390_f no_offer
2026-09-26T22:37:24Z | evo-warm-tick | attempts=254/268 last=abc396_b no_offer
2026-09-26T23:07:24Z | evo-warm-tick | attempts=258/268 last=arc182_d leak
2026-09-26T23:37:24Z | evo-warm-tick | attempts=261/268 last=arc186_c no_offer
2026-09-27T00:07:24Z | evo-warm-tick | attempts=264/268 last=arc188_d leak
2026-09-27T00:37:22Z | full-evo-warm | warm finished or summary present; starting cold if load allows
2026-09-27T00:37:22Z | full-evo-cold | started eval/bin/lsk-evo-cold.sh eval id evo-lsk1-cold
2026-09-27T00:37:24Z | evo-warm-tick | attempts=268/268 last=arc195_d no_offer
2026-09-27T00:37:24Z | evo-warm-tick | summary present, snapshotter exiting
2026-09-27T00:38:00Z | full-evo-warm | 268/268 written; test 86 success 66 leak 16 timeout 4; citations 0; distilled 268 insights 63 skills 1; offer deliveries 0; offline grade started
2026-09-27T00:38:00Z | full-evo-cold | lsk-evo-cold.sh started evo-lsk1-cold after warm summary
2026-09-27T00:46:00Z | grade-evo-warm | test 54/86=62.8% full, 54/66=81.8% graded-only; train 156/182; all 210/268; report evo-lsk1-graded/grading_report.json
2026-09-27T05:55:29Z | evo-cold-tick | attempts=80/268 last=arc186_d leak
2026-09-27T05:56:05Z | offer-root | shadow gate 不拦截；offer 只由模型 memory_offer 产生；warm 测到蒸馏 63 insights/1 skill + 频道@task，0 投递；CONSENSUS#18 未接线；demo offer 是脚本直调；warm ws 已被 destroyEvalWorkspace 删掉
2026-09-27T05:56:05Z | harness | 后续 evol 进程：保留 warm workspace、release 前 snapshot、reminder 带 conversation/task UUID、日志 explore_cites；不改正在跑的 cold bun，不改产品
2026-09-27T05:56:05Z | watchers | started lsk-cold-snapshot.sh + lsk-after-cold.sh；cold 80/268 未重启
2026-09-27T06:25:29Z | evo-cold-tick | attempts=83/268 last=arc189_c timeout
2026-09-27T06:43:41Z | grade-evo-cold | starting offline grade
2026-09-27T06:55:29Z | evo-cold-tick | attempts=86/268 last=arc195_d leak
2026-09-27T06:55:29Z | evo-cold-tick | summary present, snapshotter exiting
2026-09-27T14:28:47Z | resume | 派发增补4：evo-lsk1 两臂不重跑；隔离栈 18889/18001 在线；无 evolbench runner
2026-09-27T14:28:47Z | harness | A1 final_output 取最后含代码围栏消息（ACK 回归 2857/2902/2917 + abc320_a/abc325_e/abc379_b）；A2 settle=offer_or_memory_empty_or_task_quiet；A3 每集 sandbox snapshot；A4 分列 offer/explore/handoff
2026-09-27T14:28:47Z | harness | B publishEvalLoopOffer operationKey lsk-loop-offer-slb-*-pre|post；CRITIQUE_CADENCE=5 故无 insight 时从 distilled episode 桥一条（ensureEvalOfferTargets）；不改产品
2026-09-27T14:28:47Z | slb-smoke | starting lsk-slb-smoke-watch.sh eval id slb-lsk1-smoke families court-form-filling+fix-security-bug
2026-09-27T14:32:15Z | slb-seed | seed1 两臂全量出配对后再排 ×3；基线 sf-full-collab-1 仍占 18888，错峰
2026-09-27T14:32:15Z | slb-smoke | runner 3855580 alive; first ep court-form-filling-1 pre-offer no_targets (expected); waiting drain/post-offer
2026-09-27T17:20:00Z | slb-smoke-gate | FAIL pass=false offer=100% code=0/0 leak=100/100 sidecar_graded=false（watch 未写；B 投递通）
2026-09-28T01:50:00Z | slb-diag | 三失败同一链：task_msg=0；/verify 未先 /env（unknown episode）；A1 围栏对 SLB 错配（交付物是 /root/ 文件）；600s dead_quiet + 15min watchdog 误杀
2026-09-28T01:55:00Z | harness | SLB：harness POST /env；A1 sidecar_path=/root|/opt；dead_quiet 需无 handoff；ABORT_QUIET=0；@task 唤醒；watchdog 50min；heartbeat 120s
2026-09-28T01:49:20Z | slb-smoke | archived fail1；restarted lsk-slb-smoke-watch + after-gate；first ep sidecar_bind court-form-filling-1
2026-09-28T02:26Z | pause | 用户指令：暂停全部测试。已停：cursor 五发会话、sf3/sf4 shard、sb lane0-2、全部 evolbench/skillsbench runner（含 lsk smoke runner 1577931）。保留：web 18888/18889、centrifugo 18001、OV 容器 1933、sidecar、两库。恢复时从增补 5（SLB 三失败面诊断）与基线 sf3/sf4+sb 车道接续，勿重做已完成阶段

## 2026-10-12 — LoCoMo adversarial（cat5）跑批排障记录（基线线）
1. Oct 10 首跑（/tmp/pcm-adv-run.sh）10/10 样本全灭于 `Memory Agent start pending`，0 行产出。根因：Oct 9 磁盘迁移后 8788/8789 控制面进程死透，跑批期间无 RPC/ACK 通路（启动预检漏了这两个端口）。
2. Oct 11 15:34-15:47 有人把 18888/8789/8788 整套拉回，但 18888 vite 只带了 5 个 secret，缺 OPENVIKING_PROTOTYPE_ENABLED / COFORGE_OPENVIKING_URL / COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE → web 侧 OV gate 关闭、keys 解析不到 → 所有 ov_* 工具 `openviking-request-invalid`，读预算烧光，memory_offer 无 grounding 被 400，普通回复被 offerRequired 400 → 每题必 timeout。
3. 修复：/tmp/pcm-web-18888.sh 以完整 env 重启 18888（日志 web-run4.log）；从旧 vite 进程 env 恢复 /tmp/pcm-cursor-api-key.env（600）；pcm-adv-run.sh 加控制面预检（8788/8789/18888 不通即中止）。
4. 验证：conv-26 重跑过 startMemoryAgent，q157+ 连续 mechanism=ok，judge 出现 CORRECT（key 恢复生效）。判分仍按官方离线规则（no information available / not mentioned）。
