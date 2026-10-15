# R10 memory plane

- **`stub_server.py`**：探路波最小桩（保留不动）。
- **`plane_server.py` + `retrieval_backend.py`**：S0 真适配层（OpenViking `HybridRetrievalFacade` + 冻结 `views-r9m45/`）。

## 真适配层（S0）

```bash
cd skill-node-design-grill/impl/r10_memory_plane
export R10_GMS_TOKEN=…          # 与 bench-runner --gms-token 一致
export R10_PLANE_MODE=our       # cold | our | placebo
export R10_RECALL_LOG=/tmp/r10-s0/recalls.jsonl
python3 plane_server.py --port 8741
```

视图目录默认 `views-r9m45/`（可用 `R10_VIEWS_ROOT` 覆盖）。交回说明见 `R10-s0-report-2026-10-01.md`。

## 跑批等待

等 bench-runner 用 `wait-bench-runner.sh <pid-file>`（`kill -0` 读启动时记下的 pid）。不要在等待循环里 `pgrep -f` 一段也写在该循环 cmdline 上的模式，否则会匹配到等待进程自己。

## 桩（探路波）

## 启动

```bash
mkdir -p /tmp/r10
export R10_GMS_TOKEN=r10-blockers-local   # 与 runner --gms-token 一致，勿提交密钥
export R10_RECALL_LOG=/tmp/r10/recalls.jsonl

# cold 臂：召回恒为空（隔离空间 + 开关 off）
export R10_SERVE_RECALL=0
python3 stub_server.py --port 8741

# our 臂：对家庭 shared 空间返回 1 条固定卡片（重启进程或换环境后）
export R10_SERVE_RECALL=1
python3 stub_server.py --port 8741
```

鉴权：`Authorization: Bearer $R10_GMS_TOKEN`。

## 开关

| 变量 | 值 | 行为 |
|------|-----|------|
| `R10_SERVE_RECALL` | `0` | `POST /v1/recalls` 始终 0 条，`degradation.state=empty` |
| `R10_SERVE_RECALL` | `1` | 若 `space_ids` 含家庭级 `*-shared`（非 `*-test-N-shared` / `*-train-N-shared`）则 1 条固定条文 |
| `R10_RECALL_LOG` | 路径 | 每次 recall 请求/响应全文 JSONL |
