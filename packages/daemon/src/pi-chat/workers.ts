import {
  piChatEventSchema,
  piChatWorkerReplySchema,
  piChatScopeSchema,
  PI_CHAT_SHUTDOWN_GRACE_MS,
  type PiChatCommand,
  type PiChatEvent,
  type PiChatResult,
  type PiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { samePiChatScope, PI_CHAT_MAX_BYTES } from "@lrm/coforge-sdk/internal/pi-chat-wire";

type Pending = {
  resolve(value: PiChatResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One native worker; its stdio stays separate from Daemon logs and platform Agent capabilities. */
class PiChatWorkerProcess {
  readonly #child;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #killTimer?: ReturnType<typeof setTimeout>;
  constructor(
    scope: PiChatScope,
    command: string[],
    onEvent: (event: PiChatEvent) => void,
    removed: () => void,
  ) {
    this.#child = Bun.spawn(command, {
      env: {
        ...Object.fromEntries(
          Object.entries(Bun.env).filter(
            ([key, value]) => !key.startsWith("COFORGE_") && typeof value === "string",
          ),
        ),
        COFORGE_PI_CHAT_WORKSPACE_ID: scope.workspaceId,
        COFORGE_PI_CHAT_USER_ID: scope.userId,
        COFORGE_PI_CHAT_STREAM: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    void this.#read(onEvent).catch(() => this.close());
    void this.#child.exited.then(() => {
      void this.close();
      clearTimeout(this.#killTimer);
      removed();
    });
  }
  execute(command: PiChatCommand): Promise<PiChatResult> {
    if (this.#closed) return Promise.reject(new Error("Pi chat worker closed"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Pi chat worker timed out"));
        void this.close();
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#child.stdin.write(`${JSON.stringify({ id, command })}\n`);
        void Promise.resolve(this.#child.stdin.flush()).catch(() => this.close());
      } catch {
        void this.close();
      }
    });
  }
  async #read(onEvent: (event: PiChatEvent) => void) {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of this.#child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > PI_CHAT_MAX_BYTES) throw new Error("Pi chat worker output too large");
      let end: number;
      while ((end = text.indexOf("\n")) >= 0) {
        const value = JSON.parse(text.slice(0, end));
        text = text.slice(end + 1);
        if (value.event) {
          onEvent(piChatEventSchema.parse(value.event));
          continue;
        }
        const reply = piChatWorkerReplySchema.parse(value);
        const pending = this.#pending.get(reply.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(reply.id);
        if (reply.result) pending.resolve(reply.result);
        else pending.reject(new Error(reply.error ?? "Pi chat request failed"));
      }
    }
  }
  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#killTimer = setTimeout(
        () => this.#child.kill("SIGKILL"),
        PI_CHAT_SHUTDOWN_GRACE_MS + 5000,
      );
      this.#child.stdin.end();
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Pi chat worker closed"));
      }
      this.#pending.clear();
    }
    return this.#child.exited.then(() => {});
  }
}

/** Workspace-owned native workers, not ordinary Agents and never a second cloud connection. */
export class PiChatWorkers {
  readonly #workers = new Map<string, PiChatWorkerProcess>();
  #closed = false;
  constructor(
    private readonly binding: Pick<PiChatScope, "workspaceId" | "computerId">,
    private readonly onEvent: (event: PiChatEvent, scope: PiChatScope) => void,
    private readonly options: { command?: string[] } = {},
  ) {}
  async execute(input: PiChatScope, command: PiChatCommand) {
    if (this.#closed) throw new Error("Pi chat workers closed");
    const scope = piChatScopeSchema.parse(input);
    if (!samePiChatScope(scope, { ...this.binding, userId: scope.userId }))
      throw new Error("Pi chat scope mismatch");
    let worker = this.#workers.get(scope.userId);
    if (!worker) {
      if (this.#workers.size >= 4) throw new Error("Pi chat capacity reached");
      worker = new PiChatWorkerProcess(
        scope,
        this.options.command ?? [process.execPath, "__pi-chat"],
        (event) => this.onEvent(event, scope),
        () => this.#workers.delete(scope.userId),
      );
      this.#workers.set(scope.userId, worker);
    }
    return worker.execute(command);
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#workers.values()].map((worker) => worker.close()));
    this.#workers.clear();
  }
}
