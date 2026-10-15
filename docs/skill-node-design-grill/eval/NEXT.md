# 下一次接续（2026-09-28 01:50Z，派发增补 5）

本会话诊断了 slb-lsk1-smoke 门检失败并修了 harness，已重跑同两 family smoke。不要重做 A1–A4+B，不要重跑 evo-lsk1。

## 现在在跑（不要重启）

| 进程 | 作用 |
|---|---|
| `eval/bin/lsk-slb-smoke-watch.sh` | slb-lsk1-smoke 重跑，50 分钟静默才重启 |
| bun `evolbench-collab/src/run.ts`（cwd `cursor-lsk-eval`，`COFORGE_EVALUATION_ID=slb-lsk1-smoke`） | warm 6 + cold 4 |
| `eval/bin/lsk-after-slb-smoke.sh` | 等 smoke DONE → `lsk-slb-gate.py`；**PASS 才**起 `lsk-slb-full.sh` |
| sidecar 8734 | 沿用已有进程（勿动 8732） |
| `lsk-web-watch.sh` + vite 18889 + centrifugo 18001 | 隔离栈 |

失败冒烟已归档：`eval/logs/archive-slb-smoke-fail1/`、`benchmark/evolbench-collab/result/lsk1-smoke-fail1/`。

核对：

```bash
pgrep -af 'lsk-slb-smoke|COFORGE_EVALUATION_ID=slb-lsk1-smoke'
tail -30 /home/zhoujie22/river2_0/skill-node-design-grill/eval/logs/slb-smoke-lsk1.log
# 应先看到 sidecar_bind start/ok，再 loop_offer / mechanism
```

首集 `sidecar_bind` 可能要数分钟（docker build court-form-filling）。heartbeat 每 120s。

## 然后做什么

1. 等 `slb-lsk1-smoke-summary` + gate。门槛：warm offer≥80%；两臂 **sidecar 路径**抽出率差≤5pp；leak/timeout 差≤10pp；sidecar `graded=true`。
2. 不达标回 harness，不进全量。
3. 达标：`lsk-slb-full.sh` → `slb-lsk1` warm 95 → `lsk-after-slb-warm.sh` → `slb-lsk1-cold` 76。
4. 判分：sidecar 行内 `sidecar_verification`；协议 D McNemar + bootstrap，按 19 family 分层 win/loss。
5. seed ×3 未排。

## 不要做

- 不要重跑 / 归档重算 evo-lsk1。
- 不要再启第二个 smoke-watch / slb-warm。
- 不要动 18888 / 1933 / 8789 / 8732 / 8733 / `coforge-openviking-prototype-1` / 共享 `coforge` 库。
- 不要改 OV、coforge 主克隆、产品 offer/shadow-gate。
