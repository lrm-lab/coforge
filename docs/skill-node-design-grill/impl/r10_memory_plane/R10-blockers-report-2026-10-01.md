# R10 派发 #2 卡点测试交回（2026-10-01）

## 基线（开工前）

| 项 | 值 |
|----|-----|
| `df -h /` | 728G 总，671G 用，**20G 可用**（98%）— 高于 10G 下限，未因磁盘中止 |
| `docker system df` | Images 106.3GB（可回收 68.8GB）；Containers 23.9GB |
| `docker images \| grep -c sbbench` | **166** |
| `ss -ltn \| grep 8731`（开工前） | 无监听；8733 已被旧 sidecar 占用（未动 8733） |

## 桩

- 目录：`skill-node-design-grill/impl/r10_memory_plane/`
- 启动见同目录 `README.md`
- 本跑：memory 桩 **8741**，sidecar **8731**，token 环境变量 `R10_GMS_TOKEN`（与 runner 一致，值未写入本报告）

## §3 四条硬门

| # | 结果 | 证据 |
|---|------|------|
| ① our（warm）Pi 首条 user 含 `--- recalled memory` | **过** | `evol_bench/SkillsBench/results/r10-blockers-our/work-warm/episodes/0001-sb-court-form-filling/2026-10-01T15-39-15-518Z_01a0f81e-aebd-7557-9966-70c1164b43f0.jsonl` 首条 user：`--- recalled memory cit-r10-stub-001 (source=space-sb-office-white-collar-shared version=1) ---` |
| ② cold 对应位置 `no recalled evidence (state=empty)` | **过** | `.../r10-blockers-cold/work-cold/episodes/0001-sb-court-form-filling/2026-10-01T15-36-42-095Z_01a0f81c-576e-70ee-9114-e7fa9dc517ec.jsonl`：`no recalled evidence (state=empty).` |
| ③ 官方 verifier 出 reward | **过** | `skillsbench_grading.py` → `/tmp/r10/grading_report.json`：cold/warm `pass_rate` 均为 **1.0**；`graded_attempts.jsonl` 在 `/tmp/r10/` |
| ④ 合并 attempts 可算 `memory_gain` | **过** | `memory_gain_warm_minus_cold`: **0.0**（n=1 且两臂均 reward=1.0，数值为 0 属预期，字段存在即配对成立） |

## 原始命令与日志

```bash
# Pi 探活（指定模型）
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
/home/zhoujie22/pi-0851/node_modules/.bin/pi \
  --provider lenovo-deepseek-v4-flash --model DeepSeek-V4-Flash-0731 \
  -p --no-tools --no-session "Reply with exactly: pi-ok" \
  2>/tmp/r10/pi-probe-system-ca.log

# 桩 + sidecar
R10_GMS_TOKEN=… R10_SERVE_RECALL=0 python3 …/r10_memory_plane/stub_server.py --port 8741
python3 …/SkillsBench/code/skillsbench_env_server.py --port 8731 --log /tmp/r10/lifecycle.jsonl …

# cold / warm（详见 /tmp/r10/run-cold.log、run-warm.log）
# 判分：cat cold/our attempts → /tmp/r10/merged-attempts.jsonl
# python3 …/skillsbench_grading.py --manifest data/sb-smoke.jsonl …
```

日志索引：`/tmp/r10/pi-probe-*.log`、`run-cold.log`、`run-warm.log`、`grade.log`、`lifecycle.jsonl`、`recalls-warm.jsonl`、`grading_report.json`。
