import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

type Batch = {
  agentId: string;
  target: string;
  messages: Map<string, AgentMessageDelivery>;
  cancel?: () => void;
  flushing?: Promise<void>;
};

const schedule = (callback: () => void, milliseconds: number) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Coalesces delivery metadata; message bodies are read only by the Agent's tools.
 * Cloud Message/read boundaries remain the recovery source after a daemon restart. */
export class MemoryChannelUpdates {
  readonly #batches = new Map<string, Batch>();

  constructor(
    private readonly notify: (messages: readonly AgentMessageDelivery[]) => Promise<void>,
    private readonly options: {
      schedule?: typeof schedule;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  async add(message: AgentMessageDelivery): Promise<void> {
    const key = JSON.stringify([message.agentId, message.conversationId, message.target]);
    let batch = this.#batches.get(key);
    if (!batch) {
      batch = { agentId: message.agentId, target: message.target!, messages: new Map() };
      this.#batches.set(key, batch);
    }
    batch.messages.set(message.deliveryId, message);
    this.#arm(key, batch);
    if (batch.messages.size >= 5) await this.#flush(key, batch);
  }

  #arm(key: string, batch: Batch): void {
    if (batch.cancel || !batch.messages.size) return;
    batch.cancel = (this.options.schedule ?? schedule)(() => {
      batch.cancel = undefined;
      void this.#flush(key, batch).catch((error) => this.options.onError?.(error));
    }, 30_000);
  }

  async #flush(key: string, batch: Batch): Promise<void> {
    if (batch.flushing) return batch.flushing;
    if (this.#batches.get(key) !== batch || !batch.messages.size) return;
    batch.cancel?.();
    batch.cancel = undefined;
    const messages = [...batch.messages.values()];
    batch.messages.clear();
    const notification = Promise.resolve().then(() => this.notify(messages));
    batch.flushing = notification;
    try {
      await notification;
    } catch (error) {
      for (const message of messages) batch.messages.set(message.deliveryId, message);
      throw error;
    } finally {
      batch.flushing = undefined;
      if (this.#batches.get(key) === batch) {
        if (batch.messages.size) this.#arm(key, batch);
        else this.#batches.delete(key);
      }
    }
    if (batch.messages.size >= 5) await this.#flush(key, batch);
  }

  clearAgent(agentId: string): void {
    this.#clear((batch) => batch.agentId === agentId);
  }

  clearTarget(agentId: string, target: string): void {
    this.#clear((batch) => batch.agentId === agentId && batch.target === target);
  }

  #clear(matches: (batch: Batch) => boolean): void {
    for (const [key, batch] of this.#batches) {
      if (!matches(batch)) continue;
      batch.cancel?.();
      this.#batches.delete(key);
    }
  }
}
