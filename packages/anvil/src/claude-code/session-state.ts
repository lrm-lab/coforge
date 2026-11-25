import type { AgentNoticeOptions } from "@coforge/agent";
import type { JsonlProcess } from "#src/jsonl-process";

export type SessionState = "idle" | "running" | "interrupting" | "disposed";

export type SessionInitialization = {
  process: JsonlProcess;
  promise: Promise<void>;
};

type PendingNotice = {
  text: string;
  options?: AgentNoticeOptions;
  resolve(): void;
  reject(error: Error): void;
};

export class ClaudeNoticeQueue {
  #failure: Error | undefined;
  readonly #waiting: PendingNotice[] = [];

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }

  enqueue(text: string, options?: AgentNoticeOptions): Promise<void> {
    return new Promise<void>((resolve, reject) =>
      this.#waiting.push({ text, options, resolve, reject }),
    );
  }

  flush(send: (text: string, options?: AgentNoticeOptions) => Promise<void>): void {
    for (const notice of this.#waiting.splice(0))
      void send(notice.text, notice.options).then(notice.resolve, notice.reject);
  }

  reject(error: Error): void {
    this.#failure ??= error;
    for (const notice of this.#waiting.splice(0)) notice.reject(error);
  }
}
