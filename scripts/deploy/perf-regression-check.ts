#!/usr/bin/env bun
/**
 * Post-deploy Server Function performance check (task #594).
 *
 * Runs after a successful deploy, waits for traffic to accumulate, then
 * compares the previous image's last window against the current image's
 * first window using the journald logs that survive container recreation
 * (the compose files ship the journald logging driver for this).
 *
 * Judged per function name: p95 latency doubles AND grows by >=100ms, or
 * the 5xx rate rises by >=1pp with >=5 new failures; a function needs >=30
 * calls in BOTH windows to be judged (the 2026-11-06 CoForge production log
 * sample — 49,273 server_fn.finished lines — put the false-positive rate of plain p95-doubling at ~15%, 1/48 windows with the
 * +100ms floor). Anything below that is reported as "insufficient sample" —
 * during low-traffic periods most functions land there, so no alert does
 * not mean no problem (docs/release/github-actions.md).
 *
 * Function hashes are named by reading each digest's
 * `/app/.output/server/index.mjs` off the host (`fetchIndexMjs`).
 *
 * Alerts go to stdout as `::warning::` annotations plus a Markdown report;
 * the workflow appends the report to the job summary. Rollback is a printed
 * command only — nothing here mutates the deployment.
 *
 * Usage:
 *   bun scripts/deploy/perf-regression-check.ts \
 *     --environment staging|production \
 *     --ssh-target deploy@host --ssh-key FILE --known-hosts FILE \
 *     --remote-root DIR --project NAME \
 *     [--wait-minutes 30] [--window-minutes 30] \
 *     [--min-calls 30] [--report-file PATH]
 */

import { writeFileSync } from "node:fs";

interface Options {
  environment: string;
  sshTarget: string;
  sshKey: string;
  knownHosts: string;
  remoteRoot: string;
  project: string;
  waitMinutes: number;
  windowMinutes: number;
  minCalls: number;
  reportFile: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) {
      console.error(`bad argument near: ${key ?? "<end>"}`);
      process.exit(2);
    }
    opts[key.slice(2)] = argv[i + 1]!;
  }
  const need = (k: string) => {
    const v = opts[k];
    if (!v) {
      console.error(`missing --${k}`);
      process.exit(2);
    }
    return v;
  };
  const environment = need("environment");
  if (environment !== "staging" && environment !== "production") {
    console.error("--environment must be staging or production");
    process.exit(2);
  }
  return {
    environment,
    sshTarget: need("ssh-target"),
    sshKey: need("ssh-key"),
    knownHosts: need("known-hosts"),
    remoteRoot: need("remote-root"),
    project: need("project"),
    waitMinutes: Number(opts["wait-minutes"] ?? 30),
    windowMinutes: Number(opts["window-minutes"] ?? 30),
    minCalls: Number(opts["min-calls"] ?? 30),
    reportFile: opts["report-file"] ?? "",
  };
}

const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=8",
] as const;

function ssh(opts: Options, remoteCommand: string): string {
  const proc = Bun.spawnSync(
    [
      "ssh",
      "-i",
      opts.sshKey,
      "-o",
      `UserKnownHostsFile=${opts.knownHosts}`,
      ...SSH_OPTS,
      opts.sshTarget,
      remoteCommand,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `ssh failed (${proc.exitCode}): ${proc.stderr.toString().trim().slice(0, 500)}`,
    );
  }
  return proc.stdout.toString();
}

interface ContainerRef {
  name: string;
  image: string;
  status: string;
  startedAt: string;
  finishedAt: string;
}

/** Reads state.env and finds the web containers for the current/previous digests. */
function discover(opts: Options): {
  current: string;
  previous: string;
  containers: ContainerRef[];
} {
  const state = ssh(opts, `cat '${opts.remoteRoot}/state.env'`);
  const value = (key: string) => state.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";
  const current = value("CURRENT_WEB_IMAGE");
  const previous = value("PREVIOUS_WEB_IMAGE");
  if (!current) throw new Error(`no CURRENT_WEB_IMAGE in ${opts.remoteRoot}/state.env`);

  // One remote pass: list compose web containers and inspect each.
  const remote = `
    for id in $(docker ps -a --filter label=com.docker.compose.project=${opts.project} \\
      --filter label=com.docker.compose.service=web --format '{{.ID}}'); do
      docker inspect -f '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' "$id"
    done
  `;
  const containers: ContainerRef[] = ssh(opts, remote)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawName, image, status, startedAt, finishedAt] = line.split("|");
      return {
        name: (rawName ?? "").replace(/^\//, ""),
        image: image ?? "",
        status: status ?? "",
        startedAt: startedAt ?? "",
        finishedAt: finishedAt ?? "",
      };
    });
  return { current, previous, containers };
}

function pickContainer(
  containers: ContainerRef[],
  image: string,
  prefer: "running" | "stopped",
): ContainerRef | null {
  const matches = containers.filter((c) => c.image === image);
  if (prefer === "running") {
    return matches.find((c) => c.status === "running") ?? matches[0] ?? null;
  }
  return matches.find((c) => c.status !== "running") ?? matches[0] ?? null;
}

export interface FnStat {
  count: number;
  durations: number[];
  failures5xx: number;
}

export function parseLogWindow(text: string): Map<string, FnStat> {
  const stats = new Map<string, FnStat>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: { event?: string; fn?: string; status?: number; duration_ms?: number };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.event === "server_fn.failed") {
      // A thrown Server Function never reaches `finished`; count it as a 5xx-class failure.
      if (entry.fn) {
        const s = stats.get(entry.fn) ?? { count: 0, durations: [], failures5xx: 0 };
        s.count += 1;
        s.failures5xx += 1;
        stats.set(entry.fn, s);
      }
      continue;
    }
    if (entry.event !== "server_fn.finished" || !entry.fn) continue;
    const s = stats.get(entry.fn) ?? { count: 0, durations: [], failures5xx: 0 };
    s.count += 1;
    if (typeof entry.duration_ms === "number") s.durations.push(entry.duration_ms);
    if (typeof entry.status === "number" && entry.status >= 500) s.failures5xx += 1;
    stats.set(entry.fn, s);
  }
  return stats;
}

export function p95(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export interface NamedStat {
  name: string;
  count: number;
  p95: number | null;
  failures5xx: number;
}

export function nameStats(
  stats: Map<string, FnStat>,
  fnMap: Record<string, string>,
): Map<string, NamedStat> {
  const byName = new Map<string, NamedStat>();
  const durationsByName = new Map<string, number[]>();
  for (const [hash, s] of stats) {
    const name = fnMap[hash] ?? `(unknown ${hash.slice(0, 12)})`;
    const cur = byName.get(name) ?? { name, count: 0, p95: null, failures5xx: 0 };
    cur.count += s.count;
    cur.failures5xx += s.failures5xx;
    byName.set(name, cur);
    const durs = durationsByName.get(name) ?? [];
    durs.push(...s.durations);
    durationsByName.set(name, durs);
  }
  // p95 is computed over every duration of the name, not per-hash percentiles.
  for (const [name, durs] of durationsByName) {
    const cur = byName.get(name);
    if (cur) cur.p95 = p95(durs);
  }
  return byName;
}

/** The id→name pairing one built bundle states, same regex as the e2e helper. */
export function extractFnMap(source: string): Record<string, string> {
  const functions: Record<string, string> = {};
  const pattern =
    /([A-Za-z0-9_$]+)_createServerFn_handler\s*=\s*createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})"/g;
  for (const [, name, id] of source.matchAll(pattern)) functions[id!] = name!;
  return functions;
}

/**
 * Reads `/app/.output/server/index.mjs` for one image digest off the host:
 * `docker cp` from a container of that image when one exists, else a
 * throwaway `docker create`+`cp` against the retained image (rollback
 * redeploys the previous digest, so the image is always retained). Returns
 * null when neither is possible.
 */
function fetchIndexMjs(opts: Options, image: string): string | null {
  const remote = [
    `img='${image}'`,
    `cid=$(docker ps -aq --filter "ancestor=$img" | head -1)`,
    `tmp=`,
    `if [ -z "$cid" ]; then`,
    `  if docker image inspect "$img" >/dev/null 2>&1; then`,
    `    cid=$(docker create "$img" 2>/dev/null) && tmp=1 || { echo __NOIMAGE__; exit 0; }`,
    `  else echo __NOIMAGE__; exit 0; fi`,
    `fi`,
    `docker cp "$cid:/app/.output/server/index.mjs" - 2>/dev/null`,
    `[ -n "$tmp" ] && docker rm "$cid" >/dev/null 2>&1`,
  ].join("\n");
  const out = ssh(opts, remote);
  if (out.includes("__NOIMAGE__") || out.length < 1000) return null;
  return out;
}

function isoMinus(date: Date, minutes: number): string {
  return new Date(date.getTime() - minutes * 60_000).toISOString();
}
function isoPlus(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export interface RegressionRow {
  name: string;
  oldP95: number;
  newP95: number;
  oldN: number;
  newN: number;
  oldRate: number;
  newRate: number;
  rule: string;
}

export interface JudgeResult {
  judged: number;
  insufficient: string[];
  regressions: RegressionRow[];
}

/** Applies the task-#594 thresholds to two windows' per-name stats. */
export function judgeFunctions(
  oldStats: Map<string, NamedStat>,
  newStats: Map<string, NamedStat>,
  minCalls: number,
): JudgeResult {
  const allNames = new Set([...oldStats.keys(), ...newStats.keys()]);
  const judgedNames: string[] = [];
  const insufficient: string[] = [];
  const regressions: RegressionRow[] = [];

  for (const name of allNames) {
    const o = oldStats.get(name);
    const n = newStats.get(name);
    const oldN = o?.count ?? 0;
    const newN = n?.count ?? 0;
    if (oldN >= minCalls && newN >= minCalls) {
      judgedNames.push(name);
      const op = o!.p95 ?? 0;
      const np = n!.p95 ?? 0;
      const or = oldN ? (o!.failures5xx / oldN) * 100 : 0;
      const nr = newN ? (n!.failures5xx / newN) * 100 : 0;
      const p95Hit = op > 0 && np >= op * 2 && np - op >= 100;
      const errHit = nr - or >= 1 && n!.failures5xx >= 5 && n!.failures5xx > o!.failures5xx;
      if (p95Hit || errHit) {
        regressions.push({
          name,
          oldP95: op,
          newP95: np,
          oldN,
          newN,
          oldRate: or,
          newRate: nr,
          rule: [p95Hit && "p95", errHit && "5xx"].filter(Boolean).join("+"),
        });
      }
    } else {
      insufficient.push(name);
    }
  }
  return { judged: judgedNames.length, insufficient, regressions };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log(`environment=${opts.environment} project=${opts.project}`);
  console.log(
    `waiting ${opts.waitMinutes}min for traffic, then comparing ${opts.windowMinutes}min windows`,
  );

  // Discover state and containers BEFORE sleeping: the previous container may be
  // removed by a later deploy, and state.env is cheapest to read once.
  const { current, previous, containers } = discover(opts);
  const newContainer = pickContainer(containers, current, "running");
  const oldContainer = previous ? pickContainer(containers, previous, "stopped") : null;
  console.log(
    `current=${current.slice(0, 30)}… previous=${previous ? previous.slice(0, 30) + "…" : "(none)"}`,
  );
  console.log(`containers: new=${newContainer?.name ?? "?"} old=${oldContainer?.name ?? "gone"}`);

  // Window anchors: the old container's last minutes vs the new container's first.
  // Docker timestamps are RFC3339Nano; journalctl accepts them via --since/--until.
  const anchorNew = newContainer?.startedAt ? new Date(newContainer.startedAt) : startedAt;
  const anchorOldEnd = oldContainer?.finishedAt ? new Date(oldContainer.finishedAt) : anchorNew;
  const oldSince = isoMinus(anchorOldEnd, opts.windowMinutes);
  const oldUntil = anchorOldEnd.toISOString();
  const newSince = anchorNew.toISOString();
  const newUntil = isoPlus(anchorNew, opts.windowMinutes);

  // A gates-skipped run fires workflow_run too; only a recent container
  // boundary makes the comparison meaningful. Skip early instead of
  // burning the 30-minute wait on two stale windows.
  const boundaryAgeMin = (startedAt.getTime() - anchorNew.getTime()) / 60_000;
  if (boundaryAgeMin > opts.waitMinutes + opts.windowMinutes + 30) {
    console.log(
      `latest web container started ${Math.round(boundaryAgeMin)}min ago — no fresh deploy boundary; skipping`,
    );
    return;
  }

  const maps: Record<string, string> = {};
  for (const digest of [current, previous]) {
    if (!digest) continue;
    const mjs = fetchIndexMjs(opts, digest);
    if (mjs) {
      Object.assign(maps, extractFnMap(mjs));
    } else {
      console.error(`index.mjs unavailable for ${digest.slice(0, 50)} — its hashes stay (unknown)`);
    }
  }

  if (opts.waitMinutes > 0) {
    const waitMs = opts.waitMinutes * 60_000;
    console.log(`sleeping ${opts.waitMinutes}min until ${isoPlus(startedAt, opts.waitMinutes)}`);
    await Bun.sleep(waitMs);
  }

  // journald tags are container names; blue-green slot naming varies, so read
  // every discovered web container's tag and merge — time windows keep old and
  // new output apart even when both share one tag.
  const tags = [...new Set(containers.map((c) => c.name).filter(Boolean))];
  if (newContainer && !tags.includes(newContainer.name)) tags.push(newContainer.name);
  const readWindow = (since: string, until: string) =>
    tags
      .map((tag) =>
        ssh(
          opts,
          `journalctl --user -t '${tag}' --since '${since}' --until '${until}' -o cat --no-pager 2>/dev/null || true`,
        ),
      )
      .join("\n");

  const notes: string[] = [];
  let oldText = "";
  let newText = "";
  if (oldContainer) {
    oldText = readWindow(oldSince, oldUntil);
  } else {
    notes.push(
      "previous container is gone; old window falls back to the window before the new container started",
    );
    oldText = readWindow(isoMinus(anchorNew, opts.windowMinutes), newSince);
  }
  if (tags.length > 0) {
    newText = readWindow(newSince, newUntil);
  } else {
    notes.push("no web container found; new window is empty");
  }

  const oldStats = nameStats(parseLogWindow(oldText), maps);
  const newStats = nameStats(parseLogWindow(newText), maps);

  const { judged, insufficient, regressions } = judgeFunctions(oldStats, newStats, opts.minCalls);

  // ---- report ----
  const short = (img: string) => (img ? img.split("@").pop()!.slice(0, 19) : "-");
  const lines: string[] = [];
  lines.push(`## Post-deploy performance check — ${opts.environment}`);
  lines.push("");
  lines.push(`- deployed: \`${short(current)}\` (was \`${short(previous)}\`)`);
  lines.push(
    `- windows: old \`${oldSince.slice(0, 16)}Z\`→\`${oldUntil.slice(0, 16)}Z\` (${totalCalls(oldStats)} calls) vs new \`${newSince.slice(0, 16)}Z\`→\`${newUntil.slice(0, 16)}Z\` (${totalCalls(newStats)} calls)`,
  );
  for (const note of notes) lines.push(`- note: ${note}`);
  lines.push(
    `- judged: **${judged}** functions with ≥${opts.minCalls} calls in both windows; **${insufficient.length}** insufficient sample`,
  );
  lines.push("");
  if (regressions.length === 0) {
    lines.push("No function crossed the regression thresholds.");
  } else {
    lines.push("### Regressions");
    lines.push("");
    lines.push("| function | rule | calls old→new | p95 old→new (ms) | 5xx rate old→new |");
    lines.push("|---|---|---|---|---|");
    for (const r of regressions.sort((a, b) => b.newP95 - b.oldP95 - (a.newP95 - a.oldP95))) {
      lines.push(
        `| \`${r.name}\` | ${r.rule} | ${r.oldN}→${r.newN} | ${Math.round(r.oldP95)}→${Math.round(r.newP95)} | ${r.oldRate.toFixed(2)}%→${r.newRate.toFixed(2)}% |`,
      );
    }
    lines.push("");
    lines.push("Rollback is a human decision; the command, not run automatically:");
    if (opts.environment === "production") {
      lines.push(
        `\`gh workflow run deploy-production.yml -f image=ghcr.io/lrm-lab/coforge/coforge-web@${previous}\``,
      );
    } else {
      lines.push(
        `on the host: \`bash ${opts.remoteRoot}/scripts/deploy/rollback.sh --compose-file ${opts.remoteRoot}/infra/${opts.environment}/docker-compose.yml --state-file ${opts.remoteRoot}/state.env --project ${opts.project}\``,
      );
    }
  }
  if (insufficient.length > 0) {
    lines.push("");
    lines.push(`<details><summary>Insufficient sample (${insufficient.length})</summary>`);
    lines.push("");
    lines.push(
      insufficient
        .sort()
        .map((n) => `- ${n}`)
        .join("\n"),
    );
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  lines.push(
    "_Low-traffic windows (especially overnight) leave most functions below the 30-call floor: no alert here does not prove no regression._",
  );

  const report = lines.join("\n");
  if (opts.reportFile) writeFileSync(opts.reportFile, report);
  console.log(report);
  for (const r of regressions) {
    console.log(
      `::warning::post-deploy perf check (${opts.environment}): ${r.name} regressed (${r.rule}) p95 ${Math.round(r.oldP95)}→${Math.round(r.newP95)}ms, calls ${r.oldN}→${r.newN}`,
    );
  }
  console.log(`report${opts.reportFile ? ` written to ${opts.reportFile}` : ""}`);
}

export function totalCalls(stats: Map<string, NamedStat>): number {
  let n = 0;
  for (const s of stats.values()) n += s.count;
  return n;
}

if (import.meta.main) await main();
