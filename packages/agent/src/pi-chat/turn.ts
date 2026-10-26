import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatRuntime, PiChatStore } from "./sessions";
import { PiChatRecoveryUncertain } from "./checkpoint";
import type { PiChatQueue } from "@lrm/coforge-sdk/internal/pi-chat";

/** One admitted turn, including its durable settlement and shutdown intent. */
export class PiChatTurn {
  readonly done: Promise<void>;
  #ending?: "stopped" | "interrupted";
  #finished = false;
  readonly #admissions = new Set<Promise<void>>();
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
  get acceptingInput() {
    return !this.#finished && !this.#ending;
  }
  reserveInput() {
    if (!this.acceptingInput) throw new Error("Pi turn is settling");
    const admission = Promise.withResolvers<void>();
    this.#admissions.add(admission.promise);
    return () => {
      this.#admissions.delete(admission.promise);
      admission.resolve();
    };
  }
  queue(): PiChatQueue {
    return this.runtime.queue?.() ?? { steering: [], followUp: [] };
  }
  progress() {
    return this.runtime.progress?.();
  }
  enqueue(text: string, mode: "steer" | "followUp") {
    if (!this.runtime.enqueue) throw new Error("Pi input is unavailable");
    return this.runtime.enqueue(text, mode);
  }
  takeQueue() {
    return this.runtime.takeQueue?.() ?? { steering: [], followUp: [] };
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
    const earlierInputs = new Set(row.interruptedInputs?.map((input) => input.id));
    try {
      await run();
      status = this.#ending ?? "idle";
    } catch (error) {
      status = this.#ending ?? (error instanceof PiChatRecoveryUncertain ? "interrupted" : "error");
    } finally {
      this.#finished = true;
      try {
        await Promise.all(this.#admissions);
        // Native input hooks can outlive prompt(). A queued input in an idle runtime
        // was never consumed; keep the durable intent visible instead of dropping it.
        const queue = this.queue();
        if (
          !this.#ending &&
          (queue.steering.length ||
            queue.followUp.length ||
            row.interruptedInputs?.some((input) => !earlierInputs.has(input.id)))
        ) {
          status = "interrupted";
          row.interruptedInputs = [
            ...new Map(
              [
                ...(row.interruptedInputs ?? []),
                ...((await store.checkpoint(row.id))?.queued ?? []),
              ].map((input) => [input.id, input]),
            ).values(),
          ];
        }
        const next = { ...row, status, updatedAt: Date.now(), model: this.runtime.model() };
        await store.save(next);
        try {
          if (status !== "interrupted") await store.clearCheckpoint(row.id);
        } catch (error) {
          // Terminal metadata is durable; recovery ignores a completed turn's stale checkpoint.
          console.error(
            JSON.stringify({
              event: "pi_chat.checkpoint_cleanup_failed",
              session_id: row.id,
              error_type: error instanceof Error ? error.name : typeof error,
            }),
          );
        } finally {
          // Publish readiness only when cleanup has settled, immediately before releasing active.
          Object.assign(row, next);
        }
      } finally {
        settled();
        await this.runtime.dispose();
      }
    }
  }
}
