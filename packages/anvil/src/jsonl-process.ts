import type { AgentSessionExit } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { JsonlProtocolError, JsonlRequestError } from "./jsonl-error";
import {
  PROCESS_TREE_EXIT_GRACE_MS,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "./process-tree";
import { LineBuffer } from "./line-buffer";
import { cleanupOwnedTree, type ProcessTreeCleanupOptions } from "./process-tree-cleanup";
import { withDeadline } from "./deadline";
import { StderrCapture } from "./stderr-capture";

const logger = getLogger(["coforge", "daemon", "code-agent", "jsonl"]);

type JsonRecord = Readonly<Record<string, unknown>>;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

type ProcessState =
  | Readonly<{ type: "open" }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "disposing" }>
  | Readonly<{ type: "closed"; failureMessage?: string }>;

export class JsonlProcess {
  readonly #child: OwnedChildProcess;
  readonly #tree: OwnedProcessTree;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(record: JsonRecord) => void>();
  readonly #stderr: StderrCapture;
  readonly #stdoutFinished: Promise<void>;
  readonly #outputFinished: Promise<void>;
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<(exit: AgentSessionExit) => void>();
  #nextRequestId = 1;
  #state: ProcessState = { type: "open" };
  #cleanupPromise: Promise<void> | undefined;
  /** Whether a teardown ran and could not confirm the tree was gone. Never cleared: the process
   * is closed, so this is the only record that something may still be running under it. */
  #cleanupUnconfirmed = false;
  readonly #stderrPromise: Promise<void>;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    processTreeOwner: ProcessTreeSpawner,
    onStderrDiagnostic?: (diagnostic: string) => void,
    routineStderrLine?: (line: string) => boolean,
  ) {
    this.#tree = processTreeOwner.spawn(command, cwd, environment);
    this.#child = this.#tree.child;
    logger.info("Started code agent process", {
      event: "code_agent.process.started",
      pid: this.#child.pid,
      executable: command[0],
      argument_count: Math.max(command.length - 1, 0),
      outcome: "ok",
    });
    this.#stderr = new StderrCapture(this.#child, routineStderrLine, onStderrDiagnostic);
    this.#stderrPromise = this.#stderr.finished;
    this.#stdoutFinished = this.#readStdout();
    this.#outputFinished = Promise.all([this.#stdoutFinished, this.#stderrPromise]).then(
      () => undefined,
    );
    void this.#observeExit();
  }

  onStderr(listener: (line: string) => void): () => void {
    return this.#stderr.onLine(listener);
  }

  /** What stderr has said so far, secrets stripped and capped. Empty until a non-empty line arrives. */
  stderrExcerpt(): string {
    return this.#stderr.excerpt();
  }

  onRecord(listener: (record: JsonRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The process's records as a stream that ends once the process is over — failed or closed. A
   * consumer that reads the stream to its end has seen every record the process wrote, whatever
   * it still had queued when the process ended; closing the consumer's side on the failure
   * instead would discard that queue. `observe` sees each record synchronously, before it is
   * queued.
   */
  records(observe?: (record: JsonRecord) => void): ReadableStream<JsonRecord> {
    let stop: (() => void) | undefined;
    return new ReadableStream<JsonRecord>({
      start: (controller) => {
        const offRecord = this.onRecord((record) => {
          observe?.(record);
          controller.enqueue(record);
        });
        const end = () => {
          offRecord();
          try {
            controller.close();
          } catch {
            // The consumer already cancelled the stream.
          }
        };
        const offFailure = this.onFailure(end);
        const offClose = this.onClose(end);
        stop = () => {
          offRecord();
          offFailure();
          offClose();
        };
      },
      cancel: () => stop?.(),
    });
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (
      this.#state.type === "failed" ||
      (this.#state.type === "closed" && this.#state.failureMessage)
    ) {
      const message =
        this.#state.type === "failed" ? this.#state.message : this.#state.failureMessage!;
      queueMicrotask(() => listener(new Error(message)));
      return () => undefined;
    }
    this.#failureListeners.add(listener);
    return () => this.#failureListeners.delete(listener);
  }

  onClose(listener: (exit: AgentSessionExit) => void): () => void {
    if (this.#state.type === "closed") {
      const exit = this.exitInfo();
      queueMicrotask(() => listener(exit));
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /**
   * How the process ended, for `AgentSession.onExit`: a self-exit reports `code`, a signal
   * death reports `signal` alone, and an owner that cannot observe the cause leaves
   * `signal` undefined so a caller cannot mistake it for a proven ordinary exit.
   */
  exitInfo(): AgentSessionExit {
    const signal = this.#child.exitSignal;
    const exit: AgentSessionExit = signal
      ? { signal }
      : { code: this.#exitCode ?? null, signal: signal === undefined ? undefined : null };
    return this.#cleanupUnconfirmed ? { ...exit, cleanupUnconfirmed: true } : exit;
  }

  async send(message: JsonRecord): Promise<void> {
    this.#assertOpen();
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
      await this.#child.stdin.flush();
    } catch {
      const message = "code agent process rejected a message";
      this.#fail(message);
      throw new Error(message);
    }
  }

  interrupt(): void {
    this.#assertOpen();
    this.#child.kill("SIGINT");
  }

  /**
   * Raft's `killTurnProcesses`: SIGKILLs only the descendants the turn started and leaves this
   * process running. Owners without a turn-scoped view make this a no-op rather than guessing.
   */
  async killTurnProcesses(window: {
    startedAfterMs: number;
    startedBeforeMs?: number;
  }): Promise<void> {
    const kill = this.#tree.killTurnDescendants;
    if (!kill) return;
    const report = await kill.call(this.#tree, window.startedAfterMs, window.startedBeforeMs);
    if (report.killed.length > 0)
      logger.info("Killed code agent turn descendants", {
        event: "code_agent.process.turn_kill",
        pid: this.#child.pid,
        killed: report.killed.length,
        left_alone: report.leftAlone.length,
        outcome: "ok",
      });
  }

  async request(command: JsonRecord): Promise<JsonRecord> {
    this.#assertOpen();
    const id = `coforge-${this.#nextRequestId++}`;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.send({ ...command, id });
      logger.info("Sent code agent request", {
        event: "code_agent.request.sent",
        pid: this.#child.pid,
        request_id: id,
        method: typeof command.method === "string" ? command.method : "unknown",
        outcome: "ok",
      });
    } catch (error) {
      this.#pending.delete(id);
      void response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  async dispose(options?: ProcessTreeCleanupOptions): Promise<void> {
    if (this.#state.type === "closed") {
      // A closed process is never torn down twice. A tree an earlier teardown could not remove is
      // reported on the exit it already sent, not by throwing here: callers dispose from a cancel
      // handler or a `finally`, where that rejection would escape unhandled (#704).
      return;
    }
    if (this.#state.type === "open") {
      this.#state = { type: "disposing" };
      this.#rejectPending("code agent process closed");
    }
    try {
      await this.#cleanup(options);
      await this.#stderrPromise;
    } catch (error) {
      // Close even though the tree would not die: adapters end a session on `onClose`, so this
      // process would otherwise read as alive forever. The message stays the one consumers
      // already match on; the cleanup logs the tree it left behind (#704).
      const state = this.#state;
      const message = error instanceof Error ? error.message : "code agent cleanup failed";
      this.#cleanupUnconfirmed = true;
      try {
        if (state.type !== "failed") this.#recordFailure(message);
      } finally {
        // A failure listener that throws must not skip the close.
        this.#close();
      }
      throw error;
    }
    this.#close();
  }

  async #readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const lines = new LineBuffer();
    const accept = (line: string) => {
      if (line) this.#accept(parseRecord(line));
    };
    try {
      for await (const chunk of this.#child.stdout) {
        lines.push(decoder.decode(chunk, { stream: true }), accept);
      }
      if ((lines.rest() + decoder.decode()).trim()) throw new Error("truncated JSONL record");
    } catch (error) {
      this.#fail(
        error instanceof JsonlProtocolError
          ? error.message
          : "code agent process produced invalid output",
      );
    }
  }

  #accept(record: JsonRecord): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    const pending = id ? this.#pending.get(id) : undefined;
    if (id && pending) {
      this.#pending.delete(id);
      logger.info("Received code agent response", {
        event: "code_agent.response.received",
        pid: this.#child.pid,
        request_id: id,
        success: record.success !== false && record.error === undefined,
        error_type: record.error === undefined ? undefined : typeof record.error,
        outcome: record.success === false || record.error !== undefined ? "error" : "ok",
      });
      if (record.success === false || record.error !== undefined) {
        pending.reject(new JsonlRequestError(record.error));
      } else {
        pending.resolve(record);
      }
      return;
    }
    for (const listener of this.#listeners) listener(record);
  }

  /** The process's exit code once `#observeExit` has seen it; `undefined` while it runs. */
  #exitCode: number | undefined;

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  async #observeExit(): Promise<void> {
    const exitCode = (this.#exitCode = await this.#child.exited);
    const expectedExit = this.#state.type === "disposing" || this.#state.type === "closed";
    const properties = {
      event: "code_agent.process.exited",
      pid: this.#child.pid,
      exit_code: exitCode,
      expected_exit: expectedExit,
      outcome: expectedExit ? "ok" : "error",
    };
    if (expectedExit) logger.info("Code agent process exited", properties);
    else logger.error("Code agent process exited", properties);
    // Output the process wrote before it exited can still be unread: deliver it before the exit
    // is reported as a failure that rejects pending requests and closes the connection. A
    // descendant that kept the pipe open must not keep the exit unreported, so the wait is bounded.
    if (!expectedExit)
      await withDeadline(this.#stdoutFinished, PROCESS_TREE_EXIT_GRACE_MS, () => new Error()).catch(
        () => undefined,
      );
    this.#fail("code agent process exited unexpectedly");
  }

  #assertOpen(): void {
    if (this.#state.type === "failed") throw new Error(this.#state.message);
    if (this.#state.type === "closed" && this.#state.failureMessage)
      throw new Error(this.#state.failureMessage);
    if (this.#state.type !== "open") throw new Error("code agent process is closed");
  }

  #fail(message: string): void {
    if (this.#state.type !== "open") return;
    try {
      this.#recordFailure(message);
    } finally {
      // A failure listener that throws must not skip the teardown: the process still has to end.
      void this.#cleanup()
        .then(() => this.#close())
        .catch(() => {
          // The tree would not die, but the process is gone either way. Keep the message consumers
          // already match on rather than a composite they would no longer recognise (#704).
          this.#cleanupUnconfirmed = true;
          this.#close();
        });
    }
  }

  /** The terminal state for a process that is over: closed, remembering why it failed if it did,
   * reported exactly once. */
  #close(): void {
    if (this.#state.type === "closed") return;
    this.#state =
      this.#state.type === "failed"
        ? { type: "closed", failureMessage: this.#state.message }
        : { type: "closed" };
    this.#notifyClosed();
  }

  #recordFailure(message: string): void {
    if (this.#state.type === "closed") return;
    this.#state = { type: "failed", message };
    this.#rejectPending(message);
    for (const listener of this.#failureListeners) listener(new Error(message));
  }

  /** One teardown per process, and the first caller's options decide it — including the lossy
   * direction: a turn-scoped dispose that runs first keeps the whole-tree escalation from ever
   * happening, and now that this path ends `closed` nothing can escalate later (#704). */
  #cleanup(options?: ProcessTreeCleanupOptions): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupTree(options);
    return this.#cleanupPromise;
  }

  async #cleanupTree(options?: ProcessTreeCleanupOptions): Promise<void> {
    await cleanupOwnedTree(this.#tree, this.#child, {
      ...options,
      onKillReport: (report) => {
        logger.info("Escalated code agent turn cleanup", {
          event: "code_agent.process.turn_cleanup",
          pid: this.#child.pid,
          killed: report.killed,
          left_alone: report.leftAlone,
          outcome: "ok",
        });
        options?.onKillReport?.(report);
      },
    });
    await this.#child.exited;
    // Close means tree cleanup AND drained diagnostics, so adapters can decide
    // whether a failed native resume is eligible for a fresh launch.
    await this.#outputFinished;
  }

  #notifyClosed(): void {
    const exit = this.exitInfo();
    for (const listener of this.#closeListeners) listener(exit);
    this.#closeListeners.clear();
    this.#failureListeners.clear();
    this.#stderr.clearListeners();
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) pending.reject(new Error(message));
    this.#pending.clear();
  }
}

function parseRecord(line: string): JsonRecord {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JSONL value is not a record");
  }
  return value as JsonRecord;
}
