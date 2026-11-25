import { readdir } from "node:fs/promises";
import { isExitedProcState } from "./linux-process-table";

export type ProcJobRssGroup = { bytes: number; members: ReadonlySet<number> };
export type ProcJobRssGroups = ReadonlyMap<number, ProcJobRssGroup>;
type RssGroup = { bytes: number | undefined; members: Set<number> };
type RssRow = { pid: number; pgid: number; state: string; kib: number | undefined };

function addRssRow(groups: Map<number, RssGroup>, row: RssRow): void {
  if (row.pgid <= 1 || isExitedProcState(row.state)) return;
  const group = groups.get(row.pgid) ?? { bytes: 0, members: new Set<number>() };
  const bytes =
    row.kib === undefined || group.bytes === undefined ? undefined : group.bytes + row.kib * 1024;
  group.bytes = Number.isSafeInteger(bytes) ? bytes : undefined;
  group.members.add(row.pid);
  groups.set(row.pgid, group);
}

function completeGroups(groups: Map<number, RssGroup>): ProcJobRssGroups {
  const complete = new Map<number, ProcJobRssGroup>();
  for (const [pgid, { bytes, members }] of groups)
    if (bytes !== undefined) complete.set(pgid, { bytes, members });
  return complete;
}

export function parseProcJobPsRss(output: string): ProcJobRssGroups | undefined {
  const rows = output.trim();
  if (!rows) return undefined;
  const groups = new Map<number, RssGroup>();
  const seen = new Set<number>();
  for (const line of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const state = match[3]![0]!;
    const kib = Number(match[4]);
    if (pid <= 0 || seen.has(pid) || ![pid, pgid, kib * 1024].every(Number.isSafeInteger))
      return undefined;
    seen.add(pid);
    addRssRow(groups, { pid, pgid, state, kib });
  }
  return completeGroups(groups);
}

async function linuxRssRow(name: string): Promise<RssRow | "unavailable" | undefined> {
  try {
    const status = await Bun.file(`/proc/${name}/status`).text();
    const pid = Number(name);
    const reportedPid = /^Pid:[ \t]+(\d+)$/m.exec(status)?.[1];
    const state = /^State:[ \t]+([A-Za-z])/m.exec(status)?.[1];
    const pgid = Number(/^NSpgid:[ \t]+(\d+)/m.exec(status)?.[1]);
    const rssKiB = /^VmRSS:[ \t]+(\d+)[ \t]+kB$/m.exec(status)?.[1];
    if (pid !== Number(reportedPid) || !state || !Number.isSafeInteger(pgid)) return "unavailable";
    const kib = rssKiB === undefined ? undefined : Number(rssKiB);
    return { pid, pgid, state, kib };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOENT" || code === "ESRCH" ? undefined : "unavailable";
  }
}

async function readLinuxRssGroups(signal: AbortSignal): Promise<ProcJobRssGroups | undefined> {
  const selfStatus = await Bun.file("/proc/self/status").text();
  const procNamespacePid = /^NSpid:[ \t]+([^\n]+)$/m.exec(selfStatus)?.[1]?.trim();
  if (procNamespacePid !== String(process.pid)) return undefined;
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const groups = new Map<number, RssGroup>();
  for (let offset = 0; offset < names.length; offset += 64) {
    if (signal.aborted) return undefined;
    const rows = await Promise.all(names.slice(offset, offset + 64).map(linuxRssRow));
    for (const row of rows) {
      if (row === "unavailable") return undefined;
      if (row) addRssRow(groups, row);
    }
  }
  return signal.aborted ? undefined : completeGroups(groups);
}

export async function readProcJobRssGroups(
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<ProcJobRssGroups | undefined> {
  if (signal.aborted) return undefined;
  try {
    if (platform === "linux") return await readLinuxRssGroups(signal);
    if (platform !== "darwin") return undefined;
    const probe = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,pgid=,stat=,rss="], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      signal,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, status] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
    return status === 0 && !signal.aborted ? parseProcJobPsRss(output) : undefined;
  } catch {
    return undefined;
  }
}
