/** Child process capabilities exposed by the daemon's platform implementation. */
export interface OwnedChildProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  /**
   * The signal that ended the process (`"SIGTERM"`, …), `null` on an ordinary exit, and
   * `undefined` while it runs or when the owner cannot observe the cause (a relay whose
   * counterpart reported no detail). Read only after `exited` resolves.
   */
  readonly exitSignal?: string | null;
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
  /**
   * Raft's `killTurnProcesses`: kills only the descendants the turn started, leaving the owned
   * main process alive. `startedAfterMs`/`startedBeforeMs` bound the turn on the host's own
   * process clock, like `cutoffAtMs` above. Implementations without a safe process-table view
   * omit this capability; the caller then skips the cleanup rather than guessing.
   */
  killTurnDescendants?(
    startedAfterMs: number,
    startedBeforeMs?: number,
  ): Promise<OwnedProcessTreeKillReport>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export type ProcessCommandRunner = (command: readonly string[]) => Promise<void>;

/** PTY dimensions in character cells; only meaningful with `terminal`. */
export type ProcessTreeTerminalSize = Readonly<{ cols: number; rows: number }>;

/** Opt-in terminal transport; omitted callers retain separate pipes. */
export type ProcessTreeSpawnOptions = Readonly<{
  terminal?: boolean;
  /** The PTY's size; the transport default applies when omitted. A full-screen provider UI
   * whose layout needs more room (Droid's `/limits` panel) declares its own here. */
  terminalSize?: ProcessTreeTerminalSize;
}>;

export interface ProcessTreeSpawner {
  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    options?: ProcessTreeSpawnOptions,
  ): OwnedProcessTree;
}

/** How long each rung of process cleanup waits for the owned tree to exit, matching Raft's
 * ten-second grace after the polite SIGTERM (task #726; it was five). A cleanup ladder therefore
 * needs up to twice this, so any deadline wrapped around one must be longer. */
export const PROCESS_TREE_EXIT_GRACE_MS = 10_000;
