import { readdir, readFile } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { AGENT_LAUNCH_TAG_ENV, AGENT_LAUNCH_TAG_VALUE } from "./agent-launch-tag";

const logger = getLogger(["coforge", "daemon", "platform"]);

/** One process the host table observed: its pid, an opaque start-time stamp used to re-verify
 * identity before signaling, and the launch tag extracted while parsing. Raw environment text
 * is never retained — credentials and every other variable are dropped at the parse boundary. */
export type TaggedProcessTableEntry = {
  pid: number;
  startStamp: string;
  /** The `COFORGE_AGENT_LAUNCH_TAG` value found in the process's environment, if any. */
  tag?: { agentId: string; token: string };
};

/** The host process-table seam the sweep reads, injectable so tests never need real processes. */
export type AgentLaunchTagTable = {
  list(): Promise<readonly TaggedProcessTableEntry[]>;
  /** Re-reads one process's start stamp; undefined when it is gone or unreadable. */
  startStamp(pid: number): Promise<string | undefined>;
  alive(pid: number): Promise<boolean>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
};

export type AgentLaunchTagSweepOptions = {
  agentId: string;
  /** Consulted once per scan for the token to spare: the daemon passes its launch registry so a
   * newer launch that registered while this sweep was scanning is never killed. Every other
   * token this Agent's processes carry — earlier launches' strays included — is collected. */
  spareToken?: () => string | undefined;
  /** Why the sweep runs, for the log line: "stop", "exit" or "launch". */
  trigger: string;
  selfPid?: number;
  table?: AgentLaunchTagTable;
};

export type AgentLaunchTagSweepReport = {
  matched: number;
  killed: number;
  unkilled: { pid: number; reason: string }[];
  durationMs: number;
};

/** The entries of a report a caller must read as "that process is still there": every reason but
 * the two that mean it was already gone. A signal or scan that failed counts, so a cleanup path
 * never reads "gone" out of its own failure (#705). */
export function straySurvivors(
  report: AgentLaunchTagSweepReport,
): AgentLaunchTagSweepReport["unkilled"] {
  return report.unkilled.filter(
    (entry) => entry.reason !== "exited" && entry.reason !== "start_time_changed",
  );
}

const TERM_GRACE_MS = 300;
const SETTLE_MS = 300;

/**
 * Collects every process carrying `COFORGE_AGENT_LAUNCH_TAG` for `agentId` whose launch token is
 * not spared, then signals it. Best-effort and bounded: an unreadable entry is skipped, a process
 * that vanishes before its signal is already gone, and the whole sweep reports rather than throws
 * so a cleanup path never fails because the process table did.
 *
 * Identity is verified twice: a candidate is matched by pid plus start stamp from one listing,
 * and its stamp is re-read immediately before signaling, so a pid reused between scan and kill
 * is left alone. Only same-user processes are reachable — proc environ and `ps eww` expose
 * nothing for other users — and only the tag variable is extracted; the rest of each environment
 * is never stored or logged.
 */
export async function sweepAgentLaunchTags(
  options: AgentLaunchTagSweepOptions,
): Promise<AgentLaunchTagSweepReport> {
  const startedAt = Date.now();
  const selfPid = options.selfPid ?? process.pid;
  const report: AgentLaunchTagSweepReport = { matched: 0, killed: 0, unkilled: [], durationMs: 0 };
  try {
    const table = options.table ?? hostAgentLaunchTagTable;
    const entries = await table.list();
    // Read after the listing so a token registered while the table was being read still spares.
    const spareToken = options.spareToken?.();
    const candidates: { pid: number; startStamp: string }[] = [];
    for (const entry of entries) {
      if (entry.pid === selfPid || entry.tag === undefined) continue;
      if (entry.tag.agentId !== options.agentId) continue;
      if (spareToken !== undefined && entry.tag.token === spareToken) continue;
      candidates.push({ pid: entry.pid, startStamp: entry.startStamp });
    }
    report.matched = candidates.length;
    const verified: typeof candidates = [];
    for (const candidate of candidates) {
      const stamp = await table.startStamp(candidate.pid).catch(() => undefined);
      if (stamp === undefined) {
        report.unkilled.push({ pid: candidate.pid, reason: "exited" });
      } else if (stamp !== candidate.startStamp) {
        report.unkilled.push({ pid: candidate.pid, reason: "start_time_changed" });
      } else {
        verified.push(candidate);
      }
    }
    for (const candidate of verified) {
      try {
        table.signal(candidate.pid, "SIGTERM");
      } catch {
        report.unkilled.push({ pid: candidate.pid, reason: "signal_failed" });
      }
    }
    // Nothing to wait for when the table held no candidate (the usual case), so a caller that
    // awaits the sweep — a Start — does not pay the grace period for an empty scan (#705).
    if (verified.length) await Bun.sleep(TERM_GRACE_MS);
    const killTargets: typeof verified = [];
    for (const candidate of verified) {
      if (!(await table.alive(candidate.pid))) {
        report.killed++;
        continue;
      }
      try {
        table.signal(candidate.pid, "SIGKILL");
        killTargets.push(candidate);
      } catch {
        report.unkilled.push({ pid: candidate.pid, reason: "signal_failed" });
      }
    }
    if (killTargets.length) await Bun.sleep(SETTLE_MS);
    for (const candidate of killTargets) {
      if (await table.alive(candidate.pid)) {
        report.unkilled.push({ pid: candidate.pid, reason: "still_alive" });
      } else {
        report.killed++;
      }
    }
  } catch (error) {
    report.unkilled.push({ pid: 0, reason: `scan_failed:${diagnosticErrorCode(error)}` });
  }
  report.durationMs = Date.now() - startedAt;
  logger.info("Agent launch tag sweep finished", {
    event: "agent_launch_tag_sweep",
    agent_id: options.agentId,
    trigger: options.trigger,
    matched: report.matched,
    killed: report.killed,
    unkilled: report.unkilled,
    duration_ms: report.durationMs,
  });
  return report;
}

/** Finds the launch tag inside one process's environment text and returns its agent and token.
 * On Linux the block is NUL-separated entries; on macOS it is the `ps eww` tail where entries are
 * space-separated — the value's rigid UUID:UUID shape is matched either way, and nothing else in
 * the environment is read into the result. */
export function extractAgentLaunchTag(
  environment: string,
): { agentId: string; token: string } | undefined {
  const marker = `${AGENT_LAUNCH_TAG_ENV}=`;
  let at = environment.indexOf(marker);
  // The name must start a variable: at the text's start or after a NUL/space separator, so a
  // longer name like XCOFORGE_AGENT_LAUNCH_TAG or an argument's `--flag=` prefix cannot match.
  while (at >= 0 && at > 0 && !/[\s\0]/.test(environment[at - 1]!))
    at = environment.indexOf(marker, at + 1);
  if (at < 0) return undefined;
  const rest = environment.slice(at + marker.length);
  const end = rest.search(/[\s\0]/);
  const value = end < 0 ? rest : rest.slice(0, end);
  const match = AGENT_LAUNCH_TAG_VALUE.exec(value);
  if (!match || match.index !== 0) return undefined;
  const [agentId, token] = match[0].split(":");
  return { agentId: agentId!, token: token! };
}

const emptyAgentLaunchTagTable: AgentLaunchTagTable = {
  async list() {
    return [];
  },
  async startStamp() {
    return undefined;
  },
  async alive() {
    return false;
  },
  signal() {},
};

const procAgentLaunchTagTable: AgentLaunchTagTable = {
  async list() {
    const entries: TaggedProcessTableEntry[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const [environment, startStamp] = await Promise.all([
        readFile(`/proc/${pid}/environ`, "utf8").catch(() => undefined),
        procStartStamp(pid),
      ]);
      if (startStamp === undefined) continue;
      // The environment block is scanned for the tag and dropped here; nothing else it holds
      // reaches the entry, let alone memory past this loop iteration.
      entries.push({
        pid,
        startStamp,
        tag: environment === undefined ? undefined : extractAgentLaunchTag(environment),
      });
    }
    return entries;
  },
  startStamp: procStartStamp,
  async alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

/** The process's start time in clock ticks since boot (`/proc/<pid>/stat` field 22), an opaque
 * identity stamp: equal only while the same process holds the pid. */
async function procStartStamp(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    // After the command's last `)`: state(3) ppid(4) pgrp(5) ... starttime is field 22 overall,
    // index 19 of this tail (fields 3..22 → indices 0..19).
    const starttime = fields[19];
    return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

/** `ps ewwxo pid=,lstart=,command=` prints every process the user may inspect with its environment
 * appended; other users' processes show no environment and can never match. `lstart` is five
 * whitespace-separated fields (`Www Mmm dd hh:mm:ss yyyy`), kept verbatim as the identity stamp. */
const psAgentLaunchTagTable: AgentLaunchTagTable = {
  async list() {
    const child = Bun.spawn({
      cmd: ["ps", "ewwaxo", "pid=,lstart=,command="],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error("Host process table unavailable");
    const entries: TaggedProcessTableEntry[] = [];
    for (const line of output.split("\n")) {
      const parsed = parsePsEntry(line);
      if (parsed) entries.push(parsed);
    }
    return entries;
  },
  async startStamp(pid) {
    const child = Bun.spawn({
      cmd: ["ps", "-o", "lstart=", "-p", String(pid)],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    const output = (await new Response(child.stdout).text()).trim();
    if ((await child.exited) !== 0 || !output) return undefined;
    return output;
  },
  async alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

function parsePsEntry(line: string): TaggedProcessTableEntry | undefined {
  const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  // `ps eww` mixes the command line and the environment into one tail; the tag is extracted
  // here and the tail itself is never stored. A command argument that happens to contain a
  // complete tag-shaped value can match — accepted, documented in platform/AGENTS.md.
  return {
    pid: Number(match[1]),
    startStamp: match[2]!.trim(),
    tag: extractAgentLaunchTag(match[3]!),
  };
}

// Declared last: the platform tables are consts above, and this selection must not evaluate
// before they initialize.
const hostAgentLaunchTagTable: AgentLaunchTagTable =
  process.platform === "linux"
    ? procAgentLaunchTagTable
    : process.platform === "darwin"
      ? psAgentLaunchTagTable
      : emptyAgentLaunchTagTable;
