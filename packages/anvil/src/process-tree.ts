/** Child process capabilities exposed by the daemon's platform implementation. */
export interface OwnedChildProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stdin: { write(value: string): boolean; end(): void; flush(): Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  kill(signal?: "SIGINT" | "SIGKILL" | "SIGTERM"): void;
}

/** A process identity sampled from the host process table. */
export type OwnedProcessIdentity = Readonly<{
  pid: number;
  ppid: number;
  pgid?: number;
  startedAtMs: number;
}>;

/** Result of the turn-scoped escalation. `leftAlone` is deliberately observable for logging. */
export type OwnedProcessTreeKillReport = Readonly<{
  killed: readonly number[];
  leftAlone: readonly number[];
}>;

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  terminate(force: boolean): Promise<void>;
  /**
   * Stops the owned main process while preserving descendants that predate the interrupted turn.
   * Implementations that cannot provide a safe process-table view may omit this capability; the
   * daemon then retains its ordinary whole-tree cleanup ladder for those legacy seams.
   * `cutoffAtMs` is an instant on the host's own process clock, stamped by the host when the turn
   * began; this port only carries it.
   */
  terminateForTurn?(force: boolean, cutoffAtMs: number): Promise<OwnedProcessTreeKillReport>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export type ProcessCommandRunner = (command: readonly string[]) => Promise<void>;

export interface ProcessTreeSpawner {
  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree;
}

/** How long each rung of process cleanup waits for the owned tree to exit. */
export const PROCESS_TREE_EXIT_GRACE_MS = 5_000;
