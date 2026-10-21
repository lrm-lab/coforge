import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatRuntime, PiChatStore } from "./sessions";
import { PiChatRecoveryUncertain } from "./checkpoint";

/** One admitted turn, including its durable settlement and shutdown intent. */
export class PiChatTurn {
  readonly done: Promise<void>;
  #ending?: "stopped" | "interrupted";
  constructor(
    private readonly runtime: PiChatRuntime,
    row: PiChatSession,
    store: PiChatStore,
    run: () => Promise<void>,
    settled: () => void,
  ) {
    this.done = this.#run(row, store, run, settled);
    void this.done.catch(() => {
      row.status = "error";
    });
  }
  messages() {
    return this.runtime.messages();
  }
  async stop(status: "stopped" | "interrupted") {
    this.#ending ??= status;
    await this.runtime.abort();
    await this.done;
  }
  async #run(
    row: PiChatSession,
    store: PiChatStore,
    run: () => Promise<void>,
    settled: () => void,
  ) {
    let status: PiChatSession["status"] = "error";
    try {
      await run();
      status = this.#ending ?? "idle";
    } catch (error) {
      status = this.#ending ?? (error instanceof PiChatRecoveryUncertain ? "interrupted" : "error");
    } finally {
      const next = { ...row, status, updatedAt: Date.now(), model: this.runtime.model() };
      try {
        await store.save(next);
        Object.assign(row, next);
        if (status !== "interrupted") await store.clearCheckpoint(row.id);
      } finally {
        settled();
        await this.runtime.dispose();
      }
    }
  }
}
