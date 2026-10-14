# SWE Gemma Docker evaluation

This is the repository copy of the runtime and scheduler used for the October 14
local SWE evaluation. It is evaluation infrastructure, not a shipped Daemon adapter.
The existing AgentSession provider runs inside each task's official SWE image;
Memory stays on the host. No Pi or Daemon download is needed inside the image.

Gemma uses 20 episode slots: `lenovo-gemma` 4, and the two
`gemma-4-31b-it-2gpu-{1,2}` providers 8 each. Finished trajectories immediately
enter a separate 20-worker verifier → AO export → GLM four-role pool. These are
episode capacities, not HTTP request semaphores; Memory and Task may overlap.

## Prepare

Use the repository's pinned Bun through mise. The local Web/Agent HTTP,
Centrifugo, OpenViking and verifier must already be running. The launcher reads
required local Web credentials from `apps/web/.env`. Model keys come from private
`~/.pi/agent/models.json`, never from checked-in files or CLI arguments.

```bash
export DOCKER_HOST=unix:///data/zhoujie/docker-swe/docker.sock
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
export SSL_CERT_FILE="$NODE_EXTRA_CA_CERTS"
export COFORGE_EVAL_OPENVIKING_ROOT=/path/to/openviking-checkout
export COFORGE_EVAL_RUN_ROOT=/tmp/coforge-swe-gemma-p20
export COFORGE_EVAL_MANIFEST=/path/to/manifest-docker.jsonl
mise exec -- bun benchmark/evolbench-collab/ops/swe-gemma/runtime/build-runtime.ts
mise exec -- bun benchmark/evolbench-collab/ops/swe-gemma/runtime/preflight-delayed.ts
```

The manifest has exactly 20 rows, each with `episode_id`, grader metadata, and
`task_container: {name, image}`. Each task prompt must say the Task Agent already
runs inside `/testbed`, uses native tools, and exports its source-only patch to
`/coforge-output/patch.diff`. Do not reuse the older host-side `docker exec` prompt.

Preflight uses a mocked model, real Docker, native bash, and the existing SDK.
It delays a model response by 12 seconds, executes tools, stops and recreates the
session twice, verifies post-stop identity, and removes its uniquely named
container. Evidence remains in its printed/recorded temp directory.
The two bridge servers set `idleTimeout: 0`; the default 10 seconds truncates
slow model requests. Model/episode deadlines still apply.

## Run and inspect

```bash
/usr/bin/python3 benchmark/evolbench-collab/ops/swe-gemma/pipeline.py
# After verifying the first real trajectory and its container runtime:
touch "$(cat "$COFORGE_EVAL_RUN_ROOT/latest.txt")/allow-full-pool"
/usr/bin/python3 benchmark/evolbench-collab/ops/swe-gemma/request_error_audit.py
```

Run the controller under the local process supervisor or with redirected output
and a detached session. `latest.txt` points to a run directory containing
`config.json`, `jobs.json`, `events.jsonl`, `latest-status.json`, per-case attempts,
verdicts, AO sessions, and four-role reports. `config-template.json` supplies
budgets, and the controller records current OpenViking source hashes.

`COFORGE_EVAL_RESUME_RUN` reuses a run directory and adopts existing GLM processes.
It is for controlled recovery: stop the previous controller first, preserve old
trajectory evidence, and mark interrupted jobs `retry_pending` with a new
`runtime_retry` number. Do not run two controllers for one directory.

Each task has an ownership-labelled container, private session mount, and a
Unix socket bridge through its mounted runtime directory. Recreating a socket
must not pin an old inode with a separate socket-file bind mount. The container
has no Docker socket or host-wide credentials mount. Existing per-Agent proxy
capabilities still authorize group-chat tools.

Four-role `model-usage.jsonl` records every HTTP attempt, role, run, timing,
status and available usage. Missing usage remains unknown; interrupted runs
leave started requests without completion. Retried and retired trajectories
also cost tokens and must be included separately in cost reports.

Known limitations: the verifier's Django pytest/test-selector/stderr behavior
can produce invalid grading signals; fresh test accounts do not load a train
snapshot; upstream gateway 502s can still occur around 120 seconds. Rootless
Docker stats may omit exec workers, so verify their PID namespaces as well.

See [local Gemma evaluation guide](../../../../docs/local-gemma-evaluation.md)
for service application/restart and this machine's operating procedure.
