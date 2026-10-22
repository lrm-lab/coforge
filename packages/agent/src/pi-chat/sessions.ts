import type {
  PiChatCommand,
  PiChatMessage,
  PiChatResult,
  PiChatSession,
  PiChatUpdate,
  PiChatModel,
  PiChatQueue,
  PiChatProgress,
} from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatCheckpoint } from "./checkpoint";
import { PiChatTurn } from "./turn";

/** The native session is authoritative for transcript and model context. */
export interface PiChatRuntime {
  id: string;
  model(): string;
  messages(): PiChatMessage[];
  prompt(text: string): Promise<void>;
  resume(checkpoint: PiChatCheckpoint): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  enqueue?(text: string, mode: "steer" | "followUp"): Promise<"queued" | "handled">;
  queue?(): PiChatQueue;
  takeQueue?(): PiChatQueue;
  progress?(): PiChatProgress;
}
export interface PiChatStore {
  list(): Promise<PiChatSession[]>;
  save(session: PiChatSession): Promise<void>;
  remove(id: string): Promise<void>;
  messages(id: string): Promise<PiChatMessage[]>;
  wasAccepted(requestId: string): Promise<boolean>;
  checkpoint(id: string): Promise<PiChatCheckpoint | undefined>;
  saveCheckpoint(id: string, checkpoint: PiChatCheckpoint): Promise<void>;
  clearCheckpoint(id: string): Promise<void>;
}

/** One owner per scope; restored turns continue from native history and durable intent. */
export class PiChatSessions {
  readonly #records = new Map<string, PiChatSession>();
  readonly #active = new Map<string, PiChatTurn>();
  readonly #ready: Promise<void>;
  #mutating = Promise.resolve();
  #closing = false;
  readonly #recovery: { row: PiChatSession; checkpoint: PiChatCheckpoint }[] = [];
  constructor(
    private readonly store: PiChatStore,
    private readonly createRuntime: (id?: string, model?: PiChatModel) => Promise<PiChatRuntime>,
    private readonly onUpdate: (update: PiChatUpdate) => void = () => {},
    private readonly listModels: () => Promise<(PiChatModel & { name: string })[]> = async () => [],
  ) {
    this.#ready = this.#restore();
  }
  async #restore() {
    for (const row of await this.store.list()) {
      if (row.status === "running") {
        row.status = "interrupted";
        await this.store.save(row);
      }
      this.#records.set(row.id, row);
    }
    for (const row of this.#records.values()) {
      if (this.#closing || row.status !== "interrupted") continue;
      const checkpoint = await this.store.checkpoint(row.id);
      if (!checkpoint) continue;
      if (checkpoint.stopRequested) {
        row.status = "stopped";
        await this.store.save(row);
        await this.store.clearCheckpoint(row.id);
        continue;
      }
      // Native queues are volatile. A restart cannot prove whether an accepted queued input
      // crossed a tool boundary: keep it visible and require an explicit new send, never replay it.
      if (checkpoint.queued?.length) {
        row.interruptedInputs = [
          ...new Map(
            [...(row.interruptedInputs ?? []), ...checkpoint.queued].map((input) => [
              input.id,
              input,
            ]),
          ).values(),
        ];
        row.requestIds = [
          ...new Set([...row.requestIds, ...checkpoint.queued.map((input) => input.id)]),
        ];
        await this.store.save(row);
        continue;
      }
      if (!row.requestIds.includes(checkpoint.requestId)) continue;
      this.#recovery.push({ row, checkpoint });
    }
    await this.#drainRecovery();
  }
  async #drainRecovery() {
    while (!this.#closing && this.#active.size < 4 && this.#recovery.length) {
      const { row, checkpoint } = this.#recovery.shift()!;
      if (row.status !== "interrupted" || this.#records.get(row.id) !== row) continue;
      let runtime: PiChatRuntime | undefined;
      try {
        runtime = await this.createRuntime(row.id);
        if (this.#closing) break;
        const resumed = runtime;
        await this.#admit(row, runtime, () => resumed.resume(checkpoint));
        runtime = undefined;
      } catch {
        row.status = "interrupted";
        await this.store.save(row);
      } finally {
        await runtime?.dispose();
      }
    }
  }
  async list() {
    await this.#ready;
    return [...this.#records.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async read(id: string, before?: number) {
    await this.#ready;
    const session = this.#record(id);
    const active = this.#active.get(id);
    const messages = active ? active.messages() : await this.store.messages(id);
    const end = Math.min(before ?? messages.length, messages.length);
    const start = Math.max(0, end - 50);
    return {
      session: { ...session },
      messages: messages.slice(start, end),
      before: start,
      queue: active?.queue() ?? { steering: [], followUp: [] },
      progress: active?.progress(),
    };
  }
  start(input: {
    sessionId?: string;
    requestId: string;
    message: string;
    mode?: "steer" | "followUp";
    model?: PiChatModel;
  }) {
    return this.#exclusive(async () => {
      if (this.#closing) throw new Error("chat worker is stopping");
      const old = [...this.#records.values()].find((row) =>
        row.requestIds.includes(input.requestId),
      );
      if (old) {
        if (input.sessionId && input.sessionId !== old.id)
          throw new Error("request belongs to another session");
        return { ...old };
      }
      if (await this.store.wasAccepted(input.requestId))
        throw new Error("request belongs to a deleted session");
      if (input.sessionId) this.#record(input.sessionId);
      const active = input.sessionId ? this.#active.get(input.sessionId) : undefined;
      if (active && input.mode) {
        if (active.acceptingInput)
          return this.#enqueue(this.#record(input.sessionId!), active, input);
        await active.done;
      }
      if ((input.sessionId && this.#active.has(input.sessionId)) || this.#active.size >= 4)
        throw new Error("session is busy");
      const runtime = await this.createRuntime(input.sessionId, input.model);
      const previous = this.#records.get(runtime.id);
      const row: PiChatSession = {
        id: runtime.id,
        title: previous?.title ?? [...input.message.split("\n")[0]!].slice(0, 60).join(""),
        updatedAt: Date.now(),
        status: "running",
        requestIds: [...(previous?.requestIds ?? []), input.requestId],
        model: runtime.model(),
      };
      try {
        await this.store.saveCheckpoint(row.id, {
          requestId: input.requestId,
          message: input.message,
          messageCount: runtime.messages().length,
        });
        await this.#admit(row, runtime, () => runtime.prompt(input.message));
      } catch (error) {
        await runtime.dispose();
        throw error;
      }
      return { ...row };
    });
  }
  async #enqueue(
    row: PiChatSession,
    active: PiChatTurn,
    input: { requestId: string; message: string; mode?: "steer" | "followUp"; model?: PiChatModel },
  ) {
    if (input.model) throw new Error("cannot change model during a turn");
    const release = active.reserveInput();
    const accepted = { id: input.requestId, text: input.message, mode: input.mode! };
    let persisted = false;
    try {
      const checkpoint = await this.store.checkpoint(row.id);
      if (!checkpoint || (checkpoint.queued?.length ?? 0) >= 20)
        throw new Error("Pi input queue unavailable");
      await this.store.saveCheckpoint(row.id, {
        ...checkpoint,
        queued: [...(checkpoint.queued ?? []), accepted],
      });
      persisted = true;
      row.requestIds.push(input.requestId);
      row.updatedAt = Date.now();
      row.heldQueue = undefined;
      await this.store.save(row);
      await active.enqueue(input.message, input.mode!);
      this.#notify({ sessionId: row.id, session: { ...row }, queue: active.queue() });
      return { ...row };
    } catch (error) {
      if (persisted) {
        row.interruptedInputs = [...(row.interruptedInputs ?? []), accepted];
        await this.store.save(row);
        this.#notify({ sessionId: row.id, session: { ...row } });
      }
      throw error;
    } finally {
      release();
    }
  }
  takeQueue(id: string) {
    return this.#exclusive(async () => {
      const row = this.#record(id);
      let active = this.#active.get(id);
      if (active && !active.acceptingInput) {
        await active.done;
        active = undefined;
      }
      const release = active?.reserveInput();
      try {
        const pending = active?.takeQueue() ?? { steering: [], followUp: [] };
        const takenQueue = {
          steering: [...(row.heldQueue?.steering ?? []), ...pending.steering],
          followUp: [...(row.heldQueue?.followUp ?? []), ...pending.followUp],
        };
        // Keep the original checkpoint until the taken text has a durable home.
        // Lost replies are recoverable by read/repeated take, including after restart.
        row.heldQueue = takenQueue;
        await this.store.save(row);
        const checkpoint = await this.store.checkpoint(id);
        if (checkpoint) await this.store.saveCheckpoint(id, { ...checkpoint, queued: [] });
        this.#notify({ sessionId: id, session: { ...row }, queue: { steering: [], followUp: [] } });
        return { takenQueue, queue: { steering: [], followUp: [] } };
      } finally {
        release?.();
      }
    });
  }
  async #admit(row: PiChatSession, runtime: PiChatRuntime, run: () => Promise<void>) {
    await this.store.save({ ...row, status: "running" });
    row.status = "running";
    this.#records.set(row.id, row);
    this.#notify({ sessionId: row.id, session: { ...row } });
    this.#active.set(
      row.id,
      new PiChatTurn(runtime, row, this.store, run, () => {
        this.#active.delete(row.id);
        this.#notify({ sessionId: row.id, session: { ...row }, removeIds: ["streaming"] });
        if (!this.#closing && this.#recovery.length)
          void this.#exclusive(() => this.#drainRecovery()).catch(() => {});
      }),
    );
  }
  stop(id: string) {
    return this.#exclusive(async () => {
      this.#record(id);
      const active = this.#active.get(id);
      const checkpoint = await this.store.checkpoint(id);
      if (checkpoint) await this.store.saveCheckpoint(id, { ...checkpoint, stopRequested: true });
      if (active) {
        await active.stop("stopped");
      } else if (checkpoint) {
        const row = this.#record(id);
        await this.store.save({ ...row, status: "stopped" });
        row.status = "stopped";
        await this.store.clearCheckpoint(id);
      }
      return { ...this.#record(id) };
    });
  }
  rename(id: string, title: string) {
    return this.#exclusive(async () => {
      const row = this.#record(id);
      if (this.#active.has(id)) throw new Error("session is busy");
      const next = { ...row, title, updatedAt: Date.now() };
      await this.store.save(next);
      Object.assign(row, next);
      this.#notify({ sessionId: id, session: { ...row } });
      return next;
    });
  }
  remove(id: string) {
    return this.#exclusive(async () => {
      this.#record(id);
      if (this.#active.has(id)) throw new Error("session is busy");
      await this.store.remove(id);
      this.#records.delete(id);
      this.#notify({ sessionId: id, deleted: true });
    });
  }
  async execute(command: PiChatCommand): Promise<PiChatResult> {
    switch (command.action) {
      case "list":
        return { sessions: await this.list() };
      case "models":
        return { models: await this.listModels() };
      case "take_queue":
        return this.takeQueue(command.sessionId);
      case "read":
        return this.read(command.sessionId, command.before);
      case "start":
        return { session: await this.start(command) };
      case "stop":
        return { session: await this.stop(command.sessionId) };
      case "rename":
        return { session: await this.rename(command.sessionId, command.title) };
      case "delete":
        if (command.stop) await this.stop(command.sessionId);
        await this.remove(command.sessionId);
        return { ok: true };
    }
  }
  #record(id: string) {
    const row = this.#records.get(id);
    if (!row) throw new Error("session not found");
    return row;
  }
  #notify(update: PiChatUpdate) {
    try {
      this.onUpdate(update);
    } catch {
      /* Live feedback is repaired from native history. */
    }
  }
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#mutating.then(async () => {
      await this.#ready;
      return operation();
    });
    this.#mutating = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async dispose() {
    this.#closing = true;
    await this.#ready;
    await this.#mutating;
    await Promise.all([...this.#active.values()].map((turn) => turn.stop("interrupted")));
  }
}
