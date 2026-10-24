import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import type {
  OwnedChildProcess,
  OwnedProcessIdentity,
  OwnedProcessTreeKillReport,
  OwnedProcessTree,
  ProcessCommandRunner,
  ProcessTreeSpawner,
} from "@lrm/coforge-anvil";
import { LaunchdProcessOwner } from "./launchd-process";
import { RuntimeExecutableNotFoundError } from "./runtime-executable-not-found";
import {
  createWindowsJobObject,
  windowsJobObjectsAvailable,
  type WindowsJobObject,
  type WindowsJobObjectFactory,
} from "./windows-job-object";

export type ProcessTreeOwnerOptions = {
  /** Test seam / production factory for Windows Job Objects. */
  createJobObject?: WindowsJobObjectFactory;
  /** Test seam for the process table used by turn-scoped cleanup. */
  processTable?: ProcessTable;
};

export type ProcessTable = Readonly<{
  list(): Promise<readonly OwnedProcessIdentity[]>;
}>;

const emptyKillReport = (): OwnedProcessTreeKillReport => ({ killed: [], leftAlone: [] });

export const hostProcessTable: ProcessTable = {
  async list() {
    if (process.platform === "win32") return [];
    const child = Bun.spawn({
      cmd: ["ps", "-axo", "pid=,ppid=,pgid=,lstart="],
      // `lstart` is local time with locale-dependent month and weekday names; pin both so it is
      // read back the way it is printed on any system language.
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    return output.split("\n").flatMap(parseProcessTableLine);
  },
};

function parseProcessTableLine(line: string): OwnedProcessIdentity[] {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return [];
  const startedAtMs = Date.parse(`${match[4]!} UTC`);
  if (!Number.isFinite(startedAtMs)) return [];
  return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAtMs }];
}

function descendantsOf(
  main: OwnedProcessIdentity,
  all: readonly OwnedProcessIdentity[],
): OwnedProcessIdentity[] {
  const byParent = new Map<number, OwnedProcessIdentity[]>();
  for (const process of all) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const descendants: OwnedProcessIdentity[] = [];
  const queue = [...(byParent.get(main.pid) ?? [])];
  while (queue.length) {
    const process = queue.shift()!;
    descendants.push(process);
    queue.push(...(byParent.get(process.pid) ?? []));
  }
  return descendants;
}

const runCommand: ProcessCommandRunner = async (command) => {
  const process = Bun.spawn({
    cmd: [...command],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited ${exitCode}`);
};

/** Runs `spawn`; a spawn `ENOENT` for an executable the Agent's PATH cannot resolve becomes a
 * `RuntimeExecutableNotFoundError`. Any other `ENOENT` (a missing working directory) is rethrown
 * as it is. */
function spawnRuntime<T>(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  spawn: () => T,
): T {
  try {
    return spawn();
  } catch (error) {
    const executable = command[0] ?? "";
    if (
      hasErrorCode(error, "ENOENT") &&
      !Bun.which(executable, { cwd, PATH: environment.PATH ?? "" })
    )
      throw new RuntimeExecutableNotFoundError(executable, { cause: error });
    throw error;
  }
}

/** The `OwnedChildProcess` view of a piped `Bun.spawn` child; both launch paths share it and
 * differ only in the `exited` promise they hand out. */
function ownedChildProcess(
  spawned: Bun.Subprocess<"pipe", "pipe", "pipe">,
  exited: Promise<number>,
): OwnedChildProcess {
  return {
    get pid() {
      return spawned.pid;
    },
    exited,
    get exitCode() {
      return spawned.exitCode;
    },
    stdin: {
      write: (value) => {
        spawned.stdin.write(value);
        return true;
      },
      end: () => spawned.stdin.end(),
      flush: async () => {
        await spawned.stdin.flush();
      },
    },
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    kill: (signal) => void spawned.kill(signal),
  };
}

/** Owns the platform-specific process tree while exposing one lifecycle seam. */
export class ProcessTreeOwner implements ProcessTreeSpawner {
  constructor(
    private readonly platform = globalThis.process.platform,
    // Kept as a constructor seam for tests; Unix terminate uses process.kill, Windows uses Job Objects.
    _commandRunner: ProcessCommandRunner = runCommand,
    private readonly options: ProcessTreeOwnerOptions = {},
  ) {}

  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    if (this.platform === "win32") return this.#spawnWindows(command, cwd, environment);
    if (this.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
      const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
      if (!directory) throw new Error("Workspace Agent job directory is missing");
      return new LaunchdProcessOwner({
        directory,
        prefix: Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX,
        runner: [process.execPath, "__managed-agent"],
      }).spawn(command, cwd, environment);
    }
    const spawned = spawnRuntime(command, cwd, environment, () =>
      Bun.spawn({
        cmd: [...command],
        cwd,
        env: { ...environment },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        windowsHide: true,
      }),
    );
    const child = ownedChildProcess(spawned, spawned.exited);
    let turnScoped = false;
    let turnSnapshot: OwnedProcessIdentity[] | undefined;
    // `ps` start times have one-second resolution, so the fence is compared at that resolution.
    let turnFenceMs = 0;
    const fenced = (entry: OwnedProcessIdentity) => entry.startedAtMs >= turnFenceMs;
    const turnSurvivors = async () => {
      if (!turnSnapshot?.length) return [];
      const live = new Map(
        (await (this.options.processTable ?? hostProcessTable).list()).map((entry) => [
          entry.pid,
          entry,
        ]),
      );
      return turnSnapshot.filter(
        (entry) => fenced(entry) && live.get(entry.pid)?.startedAtMs === entry.startedAtMs,
      );
    };
    return {
      child,
      terminate: async (force) => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          globalThis.process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if (!this.#groupIsGone(error)) throw error;
        }
      },
      terminateForTurn: async (force, cutoffAtMs) => {
        const processTable = this.options.processTable ?? hostProcessTable;
        turnScoped = true;
        turnFenceMs = Math.floor(cutoffAtMs / 1_000) * 1_000;
        const pid = child.pid;
        if (pid === undefined) return emptyKillReport();
        if (!turnSnapshot) {
          const table = await processTable.list();
          const main = table.find((entry) => entry.pid === pid);
          // A detached Agent process must still be parented by this daemon. If launchd or another
          // supervisor owns it, the platform-specific owner is responsible for its kill scope.
          turnSnapshot =
            main && main.ppid === globalThis.process.pid ? descendantsOf(main, table) : [];
        }
        if (!force) {
          child.kill("SIGTERM");
          return emptyKillReport();
        }
        const current = await processTable.list();
        const byPid = new Map(current.map((entry) => [entry.pid, entry]));
        // Children the turn spawned since the snapshot, while the main process still has them.
        const liveMain = byPid.get(pid);
        const known = new Set(turnSnapshot.map((entry) => entry.pid));
        if (liveMain)
          for (const entry of descendantsOf(liveMain, current))
            if (!known.has(entry.pid)) turnSnapshot.push(entry);
        const killed: number[] = [];
        const leftAlone: number[] = [];
        for (const entry of turnSnapshot) {
          if (!fenced(entry)) {
            leftAlone.push(entry.pid);
            continue;
          }
          const live = byPid.get(entry.pid);
          if (!live || live.startedAtMs !== entry.startedAtMs) {
            leftAlone.push(entry.pid);
            continue;
          }
          try {
            // A descendant that leads its own process group takes the group it started with it.
            globalThis.process.kill(entry.pgid === entry.pid ? -entry.pid : entry.pid, "SIGKILL");
            killed.push(entry.pid);
          } catch (error) {
            if (!this.#processGone(error)) throw error;
          }
        }
        const main = byPid.get(pid);
        if (main) {
          try {
            globalThis.process.kill(pid, "SIGKILL");
            killed.push(pid);
          } catch (error) {
            if (!this.#processGone(error)) throw error;
          }
        }
        return { killed, leftAlone };
      },
      waitForExit: async (timeoutMs) => {
        const pid = child.pid;
        if (pid === undefined) return true;
        const deadline = Date.now() + timeoutMs;
        // A turn-scoped exit also waits for this turn's own descendants, which outlive the main
        // process when it dies on SIGTERM but they ignore it.
        const alive = async () =>
          turnScoped
            ? (await this.#processExists(pid)) || (await turnSurvivors()).length > 0
            : await this.#treeExists(pid);
        while (await alive()) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(turnScoped ? 100 : 20);
        }
        return true;
      },
    };
  }

  #spawnWindows(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    const createJob = this.options.createJobObject ?? defaultWindowsJobFactory;
    let job: WindowsJobObject;
    try {
      job = createJob();
    } catch (error) {
      throw new Error("Windows Agent process isolation is unavailable", { cause: error });
    }

    let spawned;
    try {
      spawned = spawnRuntime(command, cwd, environment, () =>
        Bun.spawn({
          cmd: [...command],
          cwd,
          env: { ...environment },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        }),
      );
    } catch (error) {
      job.close();
      throw error;
    }
    const pid = spawned.pid;
    if (pid === undefined) {
      job.close();
      throw new Error("Windows Agent child did not report a PID");
    }
    try {
      job.assign(pid);
    } catch (error) {
      try {
        spawned.kill();
      } catch {
        // Best-effort: assignment failed, so the Job Object never owned the tree.
      }
      job.close();
      throw error;
    }

    const child = ownedChildProcess(
      spawned,
      spawned.exited.finally(() => {
        // Keep the job handle until waitForExit/terminate can observe ActiveProcesses.
      }),
    );

    let closed = false;
    let turnScoped = false;
    const closeJob = () => {
      if (closed) return;
      closed = true;
      job.close();
    };

    return {
      child,
      terminate: async () => {
        if (closed) return;
        try {
          job.terminate(1);
        } catch (error) {
          // Already-empty jobs may reject terminate; only rethrow when members remain.
          if (!closed && job.activeProcesses() !== 0) throw error;
        }
      },
      terminateForTurn: async (force) => {
        turnScoped = true;
        if (!closed) spawned.kill(force ? "SIGKILL" : "SIGTERM");
        return emptyKillReport();
      },
      waitForExit: async (timeoutMs) => {
        if (closed) return true;
        const deadline = Date.now() + timeoutMs;
        while (!closed && (turnScoped ? spawned.exitCode === null : job.activeProcesses() > 0)) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(20);
        }
        closeJob();
        return true;
      },
    };
  }

  async #treeExists(pid: number): Promise<boolean> {
    if (this.platform === "linux") {
      for await (const entry of new Bun.Glob("[0-9]*").scan({
        cwd: "/proc",
        onlyFiles: false,
      })) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = await Bun.file(`/proc/${entry}/stat`).text();
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const state = fields[0];
          const processGroup = Number(fields[2]);
          if (processGroup === pid && state !== "Z") return true;
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      return false;
    }
    try {
      globalThis.process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (this.#groupIsGone(error)) return false;
      throw error;
    }
  }

  /** Whether a failed `kill` against the owned process group means nothing is left to signal.
   *
   * `ESRCH` says the group is gone. macOS answers `EPERM` instead while the group's only remaining
   * member is a zombie: the child has exited but its owner has not reaped it yet, and `kill`
   * refuses a group with nothing signalable left in it. A group that still holds a live process
   * answers 0, so `EPERM` means no live member - the same condition the linux branch states
   * explicitly as `state !== "Z"`. Every other failure is real and must propagate. */
  #groupIsGone(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    return code === "ESRCH" || (this.platform === "darwin" && code === "EPERM");
  }

  #processGone(error: unknown): boolean {
    return (error as { code?: string }).code === "ESRCH";
  }

  async #processExists(pid: number): Promise<boolean> {
    try {
      globalThis.process.kill(pid, 0);
      return true;
    } catch (error) {
      if (this.#processGone(error)) return false;
      throw error;
    }
  }
}

function defaultWindowsJobFactory(): WindowsJobObject {
  if (!windowsJobObjectsAvailable()) {
    throw new Error("Windows Job Object APIs are unavailable");
  }
  return createWindowsJobObject();
}
