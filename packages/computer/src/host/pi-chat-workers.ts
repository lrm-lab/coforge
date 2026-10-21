import { z } from "zod";
import {
  piChatResultSchema,
  type PiChatCommand,
  type PiChatResult,
  type PiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { dockerTaskFindArgs } from "./docker-containers";

const replySchema = z.object({
  id: z.uuid(),
  result: piChatResultSchema.optional(),
  error: z.string().optional(),
});
type Pending = {
  resolve(result: PiChatResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

class PiChatWorker {
  readonly #process;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  lastUsed = Date.now();
  constructor(
    containerId: string,
    scope: PiChatScope,
    private readonly removed: () => void,
  ) {
    this.#process = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        "--env",
        `COFORGE_PI_CHAT_WORKSPACE_ID=${scope.workspaceId}`,
        "--env",
        `COFORGE_PI_CHAT_USER_ID=${scope.userId}`,
        containerId,
        "coforge-computer",
        "__pi-chat",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    void this.#read().catch(() => this.close());
    void this.#process.exited.then(() => {
      void this.close();
      this.removed();
    });
  }
  execute(command: PiChatCommand): Promise<PiChatResult> {
    if (this.#closed) return Promise.reject(new Error("chat worker disconnected"));
    this.lastUsed = Date.now();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("chat worker timed out"));
        void this.close();
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#process.stdin.write(`${JSON.stringify({ id, command })}\n`);
        void Promise.resolve(this.#process.stdin.flush()).catch(() => this.close());
      } catch {
        void this.close();
      }
    });
  }
  async #read() {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of this.#process.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 32_000_000) throw new Error("chat response too large");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const reply = replySchema.parse(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        const call = this.#pending.get(reply.id);
        if (!call) continue;
        clearTimeout(call.timer);
        this.#pending.delete(reply.id);
        if (reply.result) call.resolve(reply.result);
        else call.reject(new Error(reply.error ?? "chat request failed"));
      }
    }
  }
  close() {
    if (!this.#closed) {
      this.#closed = true;
      // Closing docker-exec stdin lets the worker abort and persist its active sessions.
      this.#process.stdin.end();
      for (const call of this.#pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("chat worker disconnected"));
      }
      this.#pending.clear();
    }
    // Keep the registry key until docker-exec confirms remote cleanup has ended.
    return this.#process.exited.then(() => {});
  }
}

/** Each worker executes in the selected user's container, with isolated Workspace history. */
export class PiChatWorkers {
  readonly #workers = new Map<string, Promise<PiChatWorker>>();
  readonly #timer = setInterval(() => {
    for (const worker of this.#workers.values())
      void worker
        .then((entry) => {
          if (Date.now() - entry.lastUsed > 30 * 60_000) entry.close();
        })
        .catch(() => {});
  }, 60_000);
  async execute(scope: PiChatScope, command: PiChatCommand) {
    const key = `${scope.computerId}:${scope.workspaceId}:${scope.userId}`;
    let worker = this.#workers.get(key);
    if (!worker) {
      if (this.#workers.size >= 64) throw new Error("chat capacity reached");
      worker = this.#create(scope, () => this.#workers.delete(key));
      this.#workers.set(key, worker);
      void worker.catch(() => this.#workers.delete(key));
    }
    return (await worker).execute(command);
  }
  async #create(scope: PiChatScope, removed: () => void) {
    const process = Bun.spawn(["docker", ...dockerTaskFindArgs(scope.computerId)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(process.stdout).text()).trim().split("\n");
    if ((await process.exited) !== 0 || output.length !== 1 || !/^[\da-f]{12,64}$/.test(output[0]!))
      throw new Error("cloud computer is not running");
    return new PiChatWorker(output[0]!, scope, removed);
  }
  async close() {
    clearInterval(this.#timer);
    await Promise.allSettled(
      [...this.#workers.values()].map(async (worker) => (await worker).close()),
    );
    this.#workers.clear();
  }
}
