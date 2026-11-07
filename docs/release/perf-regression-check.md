# Post-deploy performance check

Task #594. After every successful Web deploy — staging and production alike — a
`perf-check` run waits 30 minutes for traffic, then compares Server Function
latency and error rates across the image boundary and annotates the run when a
function regresses.

## What it compares

Container output ships to the deploy user's persistent journald
(`journalctl --user -t <container>`), so both sides of a deploy stay readable
after the old container is gone. The job anchors two equal windows on container
timestamps from `state.env`'s digests:

- **old**: the previous image container's last 30 minutes,
- **new**: the current image container's first 30 minutes.

It parses `server_fn.finished` (and `server_fn.failed`, counted as a 5xx-class
failure) lines — `fn` hash, `status`, `duration_ms` — and aggregates per
function name. Names come from each digest's `.output/server/index.mjs`, read
off the host with `docker cp` (a throwaway `docker create` when only the
retained image remains — rollback redeploys the previous digest, so the image
is always retained). A digest whose bundle cannot be read still compares by
hash and prints `(unknown <hash>)`.

[`.github/workflows/perf-check.yml`](../../.github/workflows/perf-check.yml)
runs on `workflow_run` after each deploy workflow completes, in its own run —
a 30+ minute observation window must not occupy the deploy workflows'
`cancel-in-progress: false` concurrency group. Its job declares the matching
`environment:` so the deploy SSH identity resolves exactly as it does inside
the deploy jobs. The report annotates that run, not the deploy run.

## Thresholds

A function is judged only with ≥30 calls in **both** windows. It regresses when
either holds:

- p95 latency doubles **and** grows by ≥100ms, or
- the 5xx rate rises by ≥1 percentage point with ≥5 new failures.

The 2026-11-06 CoForge production log sample (49,273 `server_fn.finished`
lines, 174 functions) showed plain p95-doubling false-positives on ~15% of adjacent
window pairs; the +100ms floor cut that to 1/48. The 5xx rule never fired on
that sample (zero 5xx in 24h).

## Coverage caveat

Only ~5 functions average ≥30 calls per 30 minutes; the rest report
"insufficient sample". During low-traffic periods — especially overnight —
essentially nothing is judged, so **no alert does not prove no regression**.
The report lists every insufficient-sample function and states the judged
count.

## Alerting and rollback

Alerts are a `::warning::` annotation per regressed function plus a Markdown
report appended to the job summary. Nothing messages Chat or executes a
rollback: the report prints the command instead —
`gh workflow run deploy-production.yml -f image=<previous digest>` for
production, `scripts/deploy/rollback.sh` on the host for staging. A human
decides.

Implementation: `scripts/deploy/perf-regression-check.ts` (SSH discovery,
journald reads, bundle map extraction, comparison, report).
