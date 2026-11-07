import type {
  OwnedProcessIdentity,
  OwnedProcessTreeKillReport,
  OwnedProcessTree,
  ProcessTreeSpawner,
  ProcessTreeSpawnOptions,
} from "@lrm/coforge-anvil";
import { spawnOwnedChild } from "./process-transport";
import { spawnRuntime } from "./runtime-executable-not-found";
import {
  hostProcessTable,
  descendantsOf,
  killTurnDescendantsInWindow,
  type ProcessTable,
} from "./process-table";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "posix-process-tree"]);

const emptyKillReport = (): OwnedProcessTreeKillReport => ({ killed: [], leftAlone: [] });

/** A live table entry still names the recorded process only when its whole identity holds:
 * start times carry the table's resolution (one second for `ps lstart`), so a pid recycled
 * inside that window keeps the same `startedAtMs` — the process group must match too, or a
 * stranger in another group gets signaled. A recorded entry without a pgid (a table that
 * cannot report one) falls back to the start-time check. */
const sameOwnedProcess = (
  recorded: OwnedProcessIdentity,
  live: OwnedProcessIdentity | undefined,
): live is OwnedProcessIdentity =>
  live !== undefined &&
  live.startedAtMs === recorded.startedAtMs &&
  (recorded.pgid === undefined || live.pgid === recorded.pgid);

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
        const roots = [...terminalMembers.values()].filter((entry) =>
          sameOwnedProcess(entry, live.get(entry.pid)),
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
        (entry) => fenced(entry) && sameOwnedProcess(entry, live.get(entry.pid)),
      );
    };
    return {
      child,
      terminate: async (force) => {
        const pid = child.pid;
        if (pid === undefined) return;
        const live = options?.terminal ? await observeTerminal() : undefined;
        // A descendant that left the child's process group (setsid/setpgid) is invisible to the
        // group broadcast below; snapshot the tree while the ppid chain is intact so each
        // escaped member can be signaled by pid afterwards. A failed observation degrades to
        // the broadcast alone rather than skipping it.
        const descendants = child.exitCode === null ? await this.#ownedDescendants(pid) : [];
        if (child.exitCode === null) {
          // The pid is still this process (running, or a zombie Bun has not reaped), so its
          // process group can only hold this tree's members and a broadcast is safe.
          try {
            globalThis.process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
          } catch (error) {
            if (!this.#groupIsGone(error)) throw error;
          }
        } else if (!options?.terminal) await this.#killOrphanedGroupMembers(pid, force);
        await this.#signalEscapedDescendants(pid, descendants, force);
        if (live)
          for (const member of terminalMembers.values()) {
            if (!sameOwnedProcess(member, live.get(member.pid)) || member.pgid === pid) continue;
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
          if (!sameOwnedProcess(entry, live)) {
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
        // The pid is the child's only while Bun still owns it; once reaped it may name a
        // stranger, so a presence check is no license to signal it.
        if (child.exitCode === null) {
          try {
            globalThis.process.kill(pid, "SIGKILL");
            killed.push(pid);
          } catch (error) {
            if (!this.#processGone(error)) throw error;
          }
        }
        return { killed, leftAlone };
      },
      killTurnDescendants: async (startedAfterMs, startedBeforeMs) => {
        const pid = child.pid;
        if (pid === undefined) return emptyKillReport();
        // As with terminateForTurn: only a process this daemon still parents is ours to signal.
        return killTurnDescendantsInWindow(
          this.options.processTable ?? hostProcessTable,
          pid,
          globalThis.process.pid,
          startedAfterMs,
          startedBeforeMs,
        );
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
              [...terminalMembers.values()].some((entry) =>
                sameOwnedProcess(entry, live.get(entry.pid)),
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

  /** Signals each member of the owned child's group by pid, used once the child itself is
   * reaped and its pid is free for recycling: a `kill(-pgid)` broadcast could then hit a
   * foreign group that reused the id. A foreign process only enters the group by leading it,
   * so a live leader at the pid means the membership is mixed and nothing gets signaled. */
  async #killOrphanedGroupMembers(pid: number, force: boolean): Promise<void> {
    const table = await (this.options.processTable ?? hostProcessTable).list();
    if (table.find((entry) => entry.pid === pid)?.pgid === pid) return;
    for (const entry of table) {
      if (entry.pgid !== pid) continue;
      try {
        globalThis.process.kill(entry.pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (!this.#processGone(error)) throw error;
      }
    }
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

  /** The owned child's current descendants while its ppid chain is intact, or none when the
   * table cannot prove the child is still this process's. A descendant already reparented to
   * init is unreachable here by design — the same documented limit as the turn-scoped paths. */
  async #ownedDescendants(pid: number): Promise<OwnedProcessIdentity[]> {
    try {
      const table = await (this.options.processTable ?? hostProcessTable).list();
      const main = table.find((entry) => entry.pid === pid);
      if (!main || main.ppid !== globalThis.process.pid) return [];
      return descendantsOf(main, table);
    } catch (error) {
      logger.warn("Process table unavailable; descendant snapshot skipped", {
        event: "process_tree:descendant_snapshot_unavailable",
        error_message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Signals the snapshot members the group broadcast cannot reach: a descendant whose process
   * group is not the child's own (setsid/setpgid). Each is re-verified against a fresh table
   * before signaling, so a pid recycled in between is never hit; a failed observation skips the
   * pass rather than signaling unverified identities. */
  async #signalEscapedDescendants(
    pid: number,
    descendants: readonly OwnedProcessIdentity[],
    force: boolean,
  ): Promise<void> {
    const escaped = descendants.filter((entry) => entry.pgid !== pid);
    if (!escaped.length) return;
    let byPid: Map<number, OwnedProcessIdentity>;
    try {
      byPid = new Map(
        (await (this.options.processTable ?? hostProcessTable).list()).map((entry) => [
          entry.pid,
          entry,
        ]),
      );
    } catch (error) {
      logger.warn("Process table unavailable; escaped descendants not signaled", {
        event: "process_tree:escaped_descendants_unsignaled",
        error_message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const entry of escaped) {
      if (!sameOwnedProcess(entry, byPid.get(entry.pid))) continue;
      try {
        // A descendant leading its own group takes it with it; any other escaped member is
        // signaled alone so a foreign group it merely joined is never touched.
        globalThis.process.kill(
          entry.pgid === entry.pid ? -entry.pid : entry.pid,
          force ? "SIGKILL" : "SIGTERM",
        );
      } catch (error) {
        if (!this.#processGone(error)) throw error;
      }
    }
  }
}
