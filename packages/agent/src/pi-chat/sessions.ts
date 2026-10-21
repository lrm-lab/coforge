import type {
  PiChatCommand,
  PiChatMessage,
  PiChatResult,
  PiChatSession,
} from "@lrm/coforge-sdk/internal/pi-chat";

/** The native session is authoritative for transcript and model context. */
export interface PiChatRuntime {
  id: string;
  model(): string;
  messages(): PiChatMessage[];
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
export interface PiChatStore {
  list(): Promise<PiChatSession[]>;
  save(session: PiChatSession): Promise<void>;
  remove(id: string): Promise<void>;
  messages(id: string): Promise<PiChatMessage[]>;
  wasAccepted(requestId: string): Promise<boolean>;
}
type Active = { runtime: PiChatRuntime; done: Promise<void>; stopping: boolean };

/** One owner per user/workspace worker; accepted prompts are never automatically replayed. */
export class PiChatSessions {
  readonly #records = new Map<string, PiChatSession>();
  readonly #active = new Map<string, Active>();
  readonly #ready: Promise<void>;
  #mutating = Promise.resolve();
  constructor(
    private readonly store: PiChatStore,
    private readonly createRuntime: (id?: string) => Promise<PiChatRuntime>,
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
    const messages = active ? active.runtime.messages() : await this.store.messages(id);
    const end = Math.min(before ?? messages.length, messages.length);
    const start = Math.max(0, end - 50);
    return { session: { ...session }, messages: messages.slice(start, end), before: start };
  }
  start(input: { sessionId?: string; requestId: string; message: string }) {
    return this.#exclusive(async () => {
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
      if ((input.sessionId && this.#active.has(input.sessionId)) || this.#active.size >= 4)
        throw new Error("session is busy");
      const runtime = await this.createRuntime(input.sessionId);
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
        await this.store.save(row);
      } catch (error) {
        await runtime.dispose();
        throw error;
      }
      this.#records.set(row.id, row);
      const active: Active = { runtime, stopping: false, done: Promise.resolve() };
      this.#active.set(row.id, active);
      active.done = this.#run(row, active, input.message);
      // stop() still observes a settlement failure; detached turns must not cause
      // an unhandled rejection if storage or cleanup fails after the HTTP reply.
      void active.done.catch(() => {
        row.status = "error";
      });
      return { ...row };
    });
  }
  async #run(row: PiChatSession, active: Active, message: string) {
    try {
      await active.runtime.prompt(message);
      row.status = active.stopping ? "stopped" : "idle";
    } catch {
      row.status = active.stopping ? "stopped" : "error";
    } finally {
      row.updatedAt = Date.now();
      row.model = active.runtime.model();
      try {
        await this.store.save(row);
      } finally {
        this.#active.delete(row.id);
        await active.runtime.dispose();
      }
    }
  }
  stop(id: string) {
    return this.#exclusive(async () => {
      this.#record(id);
      const active = this.#active.get(id);
      if (active) {
        active.stopping = true;
        await active.runtime.abort();
        await active.done;
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
      this.#records.set(id, next);
      return next;
    });
  }
  remove(id: string) {
    return this.#exclusive(async () => {
      this.#record(id);
      if (this.#active.has(id)) throw new Error("session is busy");
      await this.store.remove(id);
      this.#records.delete(id);
    });
  }
  async execute(command: PiChatCommand): Promise<PiChatResult> {
    switch (command.action) {
      case "list":
        return { sessions: await this.list() };
      case "read":
        return this.read(command.sessionId, command.before);
      case "start":
        return { session: await this.start(command) };
      case "stop":
        return { session: await this.stop(command.sessionId) };
      case "rename":
        return { session: await this.rename(command.sessionId, command.title) };
      case "delete":
        await this.remove(command.sessionId);
        return { ok: true };
    }
  }
  #record(id: string) {
    const row = this.#records.get(id);
    if (!row) throw new Error("session not found");
    return row;
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
    await this.#ready;
    await this.#mutating;
    await Promise.all([...this.#active.keys()].map((id) => this.stop(id)));
  }
}
