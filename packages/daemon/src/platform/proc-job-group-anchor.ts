import { readdir } from "node:fs/promises";
import { isExitedProcState, parseProcStat } from "./linux-process-table";
import type { ProcJobScopePayload } from "./proc-job-scope-gate";

const PROCESS_GROUP_POLL_MS = 500;

export function procJobGroupAnchorCommand(): string[] {
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, "__proc-job-group-anchor"]
    : [process.execPath, "run", "--no-env-file", import.meta.path];
}

async function linuxGroupHasMembers(
  pgid: number,
  excludePid?: number,
): Promise<boolean | undefined> {
  const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  let incomplete = false;
  for (let offset = 0; offset < entries.length; offset += 64) {
    const members = await Promise.all(
      entries.slice(offset, offset + 64).map(async (entry) => {
        if (Number(entry) === excludePid) return false;
        try {
          const stat = parseProcStat(await Bun.file(`/proc/${entry}/stat`).text());
          return stat && stat.pgid === pgid && !isExitedProcState(stat.state);
        } catch (error) {
          const code = (error as { code?: string }).code;
          return code === "ENOENT" || code === "ESRCH" ? false : undefined;
        }
      }),
    );
    if (members.includes(true)) return true;
    if (members.includes(undefined)) incomplete = true;
  }
  return incomplete ? undefined : false;
}

export async function procJobGroupHasMembers(
  pgid: number,
  platform: NodeJS.Platform,
  excludePid?: number,
): Promise<boolean | undefined> {
  if (pgid < 2 || (platform !== "darwin" && platform !== "linux")) return undefined;
  try {
    if (platform === "linux") return await linuxGroupHasMembers(pgid, excludePid);
    const selection = excludePid === undefined ? ["-A"] : ["-g", String(pgid)];
    const probe = Bun.spawn(["/bin/ps", ...selection, "-o", "pid=,pgid=,stat="], {
      cwd: "/",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
    });
    const [output, status] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
    if (status !== 0 || !output.trim()) return undefined;
    let hasOtherMembers = false;
    for (const line of output.trim().split("\n")) {
      const member = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!member) return undefined;
      const pid = Number(member[1]);
      if (
        Number(member[2]) === pgid &&
        pid !== excludePid &&
        pid !== probe.pid &&
        !member[3]!.startsWith("Z")
      )
        hasOtherMembers = true;
    }
    return hasOtherMembers;
  } catch {
    return undefined;
  }
}

export async function runProcJobGroupAnchor(): Promise<void> {
  const preserveAnchor = () => {};
  process.on("SIGTERM", preserveAnchor);
  try {
    const { command, cwd, env } = JSON.parse(await Bun.stdin.text()) as ProcJobScopePayload;
    const root = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await root.exited;
    while ((await procJobGroupHasMembers(process.pid, process.platform, process.pid)) !== false)
      await Bun.sleep(PROCESS_GROUP_POLL_MS);
    process.removeListener("SIGTERM", preserveAnchor);
    if (root.signalCode) process.kill(process.pid, root.signalCode);
    process.exit(exitCode);
  } catch {
    process.exit(125);
  }
}

if (import.meta.main) await runProcJobGroupAnchor();
