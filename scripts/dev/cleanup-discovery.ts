// Finds the current user's processes with their working directory for `mise run cleanup`
// (scripts/dev/cleanup.ts): `lsof` and `ps` on macOS, `/proc` on Linux. Both scans must see this
// very process with its directory, or the scan cannot be trusted and it fails.
import { access, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { firstLine, run, type Runner } from "./cleanup-exec";
import { parseLsofCwd, parseProcessTable, type ProcessInfo } from "./cleanup-plan";

export const DISCOVERY_TIMEOUT_MILLISECONDS = 15_000;
const DELETED_SUFFIX = " (deleted)";
/** Programs whose process may hold a worktree as its directory: shells, and the dev runtimes. */
const WATCHED_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "pwsh",
  "nu",
  "dash",
  "ksh",
  "tcsh",
  "bun",
  "node",
]);

/** The program name of a command line; a login shell shows as `-zsh`. */
const programOf = (command: string) =>
  command.trim().split(/\s+/)[0]!.split("/").pop()!.replace(/^-/, "");

export type DiscoveryOptions = {
  platform?: string;
  /** Where the Linux process files are; `/proc` unless a test builds a stand-in. */
  procRoot?: string;
  run?: Runner;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const inside = (cwd: string, roots: string[]) =>
  roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));

async function discoverDarwin(roots: string[], exec: Runner, uid: number): Promise<ProcessInfo[]> {
  const [table, directories] = await Promise.all([
    exec(["ps", "-x", "-o", "pid=,command="]),
    exec(["lsof", "-a", "-d", "cwd", "-Fpcn", "-u", String(uid)], {
      timeout: DISCOVERY_TIMEOUT_MILLISECONDS,
    }),
  ]);
  if (!table.ok) throw new Error(`ps failed: ${firstLine(table.stderr)}`);
  if (!directories.ok)
    throw new Error(
      directories.timedOut
        ? `lsof timed out after ${DISCOVERY_TIMEOUT_MILLISECONDS / 1000} s`
        : `lsof failed: ${firstLine(directories.stderr) || "non-zero exit"}`,
    );
  const commands = parseProcessTable(table.stdout);
  const listed = parseLsofCwd(directories.stdout);
  if (!listed.has(process.pid))
    throw new Error("lsof did not list this process, so its output cannot be trusted");
  // lsof can leave out a process of ours and still exit 0. A shell or dev runtime that `ps` shows
  // and lsof does not, and that is still alive, means the scan missed a possible user of a worktree.
  for (const [pid, command] of commands) {
    if (listed.has(pid) || !WATCHED_PROGRAMS.has(programOf(command))) continue;
    if ((await exec(["ps", "-p", String(pid), "-o", "command="])).ok)
      throw new Error(`lsof did not list pid ${pid} (${command}), so its directory is unknown`);
  }
  const found: ProcessInfo[] = [];
  for (const [pid, { name, cwd }] of listed) {
    if (pid === process.pid || !inside(cwd, roots)) continue;
    found.push({ pid, command: commands.get(pid) ?? name, cwd, cwdExists: await exists(cwd) });
  }
  return found;
}

/** `/proc/<pid>/cmdline` as one line: the arguments are NUL-separated. Undefined when it is gone. */
async function readCommandLine(procRoot: string, pid: number): Promise<string | undefined> {
  try {
    const text = await Bun.file(join(procRoot, String(pid), "cmdline")).text();
    return text.split("\0").filter(Boolean).join(" ") || undefined;
  } catch (error) {
    if (isGone(error)) return undefined;
    throw error;
  }
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
/** A process that ended while the scan ran. */
const isGone = (error: unknown) => code(error) === "ENOENT" || code(error) === "ESRCH";

/** The real uid of `/proc/<pid>/status`. */
export function realUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  return match ? Number(match[1]) : undefined;
}

/**
 * The kernel makes `/proc/<pid>` root's for a process that is not dumpable (a setuid program, say),
 * whatever its owner; such a process can be ours yet unreadable.
 */
export function hiddenOwnProcess(owner: number, status: string, uid: number): boolean {
  return owner === 0 && uid !== 0 && realUid(status) === uid;
}

/** The `Uid`, `Gid` and `CapPrm` lines of a `/proc/<pid>/status`, or undefined without all three. */
function credentials(status: string): string | undefined {
  const lines = ["Uid", "Gid", "CapPrm"].map((name) =>
    new RegExp(`^${name}:\\s+(.+)$`, "m").exec(status)?.[1]?.trim(),
  );
  return lines.every((line) => line !== undefined) ? lines.join("|") : undefined;
}

/**
 * Whether an unreadable process of our uid is explained by its credentials differing from ours:
 * the kernel refuses `/proc/<pid>/cwd` (ptrace read access,
 * https://man7.org/linux/man-pages/man2/ptrace.2.html) when the target has another real,
 * effective or saved uid or gid, or capabilities we lack, as gnome-keyring-daemon or a CI runner's
 * agent does. One with our very credentials, or whose credentials cannot be read, is unexplained.
 */
export function withheldProcess(status: string, ownStatus: string): boolean {
  const theirs = credentials(status);
  const ours = credentials(ownStatus);
  return theirs !== undefined && ours !== undefined && theirs !== ours;
}

async function discoverLinux(roots: string[], procRoot: string, uid: number) {
  const self = Number(await readlink(join(procRoot, "self")).catch(() => Number.NaN));
  if (!Number.isInteger(self)) throw new Error("cannot tell which process this is under /proc");
  const pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name)).map(Number);
  const found: ProcessInfo[] = [];
  let sawSelf = false;
  for (const pid of pids) {
    const dir = join(procRoot, String(pid));
    try {
      const owner = await stat(dir);
      if (owner.uid !== uid) {
        const status = owner.uid === 0 ? await Bun.file(join(dir, "status")).text() : "";
        if (hiddenOwnProcess(owner.uid, status, uid))
          throw new Error(`pid ${pid} is ours but /proc hides it (not dumpable)`);
        continue;
      }
      const target = await readlink(join(dir, "cwd")).catch(async (error: unknown) => {
        if (isGone(error)) throw error;
        const [status, own] = await Promise.all(
          [dir, join(procRoot, String(self))].map((at) =>
            Bun.file(join(at, "status"))
              .text()
              .catch(() => ""),
          ),
        );
        // A shell or dev runtime may still be ours in a worktree (`newgrp`, `sg`): its command
        // line is not withheld, and the scan cannot vouch for it.
        const command = (await readCommandLine(procRoot, pid)) ?? "";
        if (withheldProcess(status, own) && !WATCHED_PROGRAMS.has(programOf(command)))
          return undefined;
        throw new Error(
          `${(error as Error).message} (${command || "no command line"}; credentials ${
            credentials(status) ?? "unreadable"
          }, ours ${credentials(own) ?? "unreadable"})`,
          { cause: error },
        );
      });
      if (target === undefined) continue;
      if (pid === self) sawSelf = true;
      const deleted = target.endsWith(DELETED_SUFFIX);
      const cwd = deleted ? target.slice(0, -DELETED_SUFFIX.length) : target;
      if (pid === self || !inside(cwd, roots)) continue;
      found.push({
        pid,
        command: (await readCommandLine(procRoot, pid)) ?? "(unknown)",
        cwd,
        cwdExists: !deleted && (await exists(cwd)),
      });
    } catch (error) {
      if (isGone(error)) continue;
      throw new Error(`cannot read pid ${pid} under /proc: ${(error as Error).message}`);
    }
  }
  if (!sawSelf)
    throw new Error("the process scan did not find this process, so it cannot be trusted");
  return found;
}

/**
 * Processes of the current user whose directory is inside one of `roots`, other than this one.
 * Windows has no scan (empty). Throws when the scan is unavailable on this platform or cannot be
 * trusted.
 */
export async function discoverProcesses(
  roots: string[],
  options: DiscoveryOptions = {},
): Promise<ProcessInfo[]> {
  const platform = options.platform ?? process.platform;
  // Windows cannot report another process's directory; `cleanup-system.ts` probes each worktree.
  if (platform === "win32") return [];
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the user id is unknown");
  if (platform === "darwin") return discoverDarwin(roots, options.run ?? run, uid);
  if (platform === "linux") return discoverLinux(roots, options.procRoot ?? "/proc", uid);
  throw new Error(`process discovery supports macOS, Linux and Windows only, not ${platform}`);
}

/** The pid's command line now, in the form `discoverProcesses` reports; undefined when gone. */
export async function commandOf(
  pid: number,
  options: DiscoveryOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) === "linux")
    return readCommandLine(options.procRoot ?? "/proc", pid);
  const listing = await (options.run ?? run)(["ps", "-p", String(pid), "-o", "command="]);
  const command = listing.stdout.trim();
  return listing.ok && command !== "" ? command : undefined;
}
