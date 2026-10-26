import type {
  OwnedProcessIdentity,
  OwnedProcessTreeKillReport,
  OwnedProcessTree,
  ProcessTreeSpawner,
  ProcessTreeSpawnOptions,
} from "@lrm/coforge-anvil";
import { spawnOwnedChild } from "./process-transport";
import { spawnRuntime } from "./runtime-executable-not-found";
import { hostProcessTable, descendantsOf, type ProcessTable } from "./process-table";

const emptyKillReport = (): OwnedProcessTreeKillReport => ({ killed: [], leftAlone: [] });

/** The POSIX owner used directly and inside a native launchd relay. */
export class PosixProcessOwner implements ProcessTreeSpawner {
  constructor(
    private readonly platform = process.platform,
    private readonly options: { processTable?: ProcessTable } = {},
  ) {}
  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    options?: ProcessTreeSpawnOptions,
  ): OwnedProcessTree {
    const child = spawnRuntime(command, cwd, environment, () =>
      spawnOwnedChild(command, cwd, environment, { ...options, detached: true }),
    );
    // A terminal creates a separate session. Snapshot all descendants before TERM so a
    // child that calls setsid remains owned after its parent exits and it is reparented.
    const terminalMembers = new Map<number, OwnedProcessIdentity>();
    let observations = Promise.resolve();
    const observeTerminal = () => {
      const next = observations.then(async () => {
        const table = await (this.options.processTable ?? hostProcessTable).list();
        const live = new Map(table.map((entry) => [entry.pid, entry]));
        const main = child.exitCode === null ? live.get(child.pid!) : undefined;
        const roots = [...terminalMembers.values()].filter(
          (entry) => live.get(entry.pid)?.startedAtMs === entry.startedAtMs,
        );
        if (main && main.ppid === process.pid) roots.push(main);
        for (const root of roots) {
          terminalMembers.set(root.pid, root);
          for (const entry of descendantsOf(root, table)) terminalMembers.set(entry.pid, entry);
        }
        return live;
      });
      observations = next.then(
        () => {},
        () => {},
      );
      return next;
    };
    let turnScoped = false;
    let turnSnapshot: OwnedProcessIdentity[] | undefined;
    // Start times have the process table's resolution, so the fence is compared at that resolution.
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
        const live = options?.terminal ? await observeTerminal() : undefined;
        try {
          globalThis.process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if (!this.#groupIsGone(error)) throw error;
        }
        if (live)
          for (const member of terminalMembers.values()) {
            if (live.get(member.pid)?.startedAtMs !== member.startedAtMs || member.pgid === pid)
              continue;
            try {
              process.kill(
                member.pgid === member.pid ? -member.pid : member.pid,
                force ? "SIGKILL" : "SIGTERM",
              );
            } catch (error) {
              if (!this.#processGone(error)) throw error;
            }
          }
      },
      terminateForTurn: async (force, cutoffAtMs) => {
        const processTable = this.options.processTable ?? hostProcessTable;
        turnScoped = true;
        const resolutionMs = processTable.resolutionMs ?? 1_000;
        turnFenceMs = Math.floor(cutoffAtMs / resolutionMs) * resolutionMs;
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
        const alive = async () => {
          if (options?.terminal) {
            const live = await observeTerminal();
            if (
              [...terminalMembers.values()].some(
                (entry) => live.get(entry.pid)?.startedAtMs === entry.startedAtMs,
              )
            )
              return true;
          }
          return turnScoped
            ? (await this.#processExists(pid)) || (await turnSurvivors()).length > 0
            : await this.#treeExists(pid);
        };
        while (await alive()) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(turnScoped ? 100 : 20);
        }
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
