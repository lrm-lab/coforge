import type { JsonlProcess } from "#src/jsonl-process";

export type SessionState = "idle" | "running" | "interrupting" | "disposed";

export type SessionInitialization = {
  process: JsonlProcess;
  promise: Promise<void>;
};

type PendingNotice = {
  text: string;
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

  enqueue(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => this.#waiting.push({ text, resolve, reject }));
  }

  flush(send: (text: string) => Promise<void>): void {
    for (const notice of this.#waiting.splice(0))
      void send(notice.text).then(notice.resolve, notice.reject);
  }

  reject(error: Error): void {
    this.#failure ??= error;
    for (const notice of this.#waiting.splice(0)) notice.reject(error);
  }
}
