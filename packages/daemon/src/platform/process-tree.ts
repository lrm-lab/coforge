import type {
  OwnedProcessTreeKillReport,
  OwnedProcessTree,
  ProcessCommandRunner,
  ProcessTreeSpawner,
  ProcessTreeSpawnOptions,
} from "@lrm/coforge-anvil";
import { spawnOwnedChild } from "./process-transport";
import { LaunchdProcessOwner } from "./launchd-process";
import { PosixProcessOwner } from "./posix-process-tree";
import type { ProcessTable } from "./process-table";
export {
  psProcessTable,
  hostProcessTable,
  processClockMs,
  type ProcessTable,
} from "./process-table";
import { spawnRuntime } from "./runtime-executable-not-found";
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

const emptyKillReport = (): OwnedProcessTreeKillReport => ({ killed: [], leftAlone: [] });

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
    options?: ProcessTreeSpawnOptions,
  ): OwnedProcessTree {
    if (this.platform === "win32") return this.#spawnWindows(command, cwd, environment, options);
    if (this.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
      const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
      if (!directory) throw new Error("Workspace Agent job directory is missing");
      return new LaunchdProcessOwner({
        directory,
        prefix: Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX,
        runner: [process.execPath, "__managed-agent"],
      }).spawn(command, cwd, environment, options);
    }
    return new PosixProcessOwner(this.platform, this.options).spawn(
      command,
      cwd,
      environment,
      options,
    );
  }

  #spawnWindows(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    options?: ProcessTreeSpawnOptions,
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
        spawnOwnedChild(command, cwd, environment, options),
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
        spawned.kill("SIGKILL");
        spawned.stdin.end();
      } catch {
        // Best-effort: assignment failed, so the Job Object never owned the tree.
      }
      job.close();
      throw error;
    }

    const child = spawned;

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
}

function defaultWindowsJobFactory(): WindowsJobObject {
  if (!windowsJobObjectsAvailable()) {
    throw new Error("Windows Job Object APIs are unavailable");
  }
  return createWindowsJobObject();
}
