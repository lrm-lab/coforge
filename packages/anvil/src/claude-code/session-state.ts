import type { JsonlProcess } from "#src/jsonl-process";

export type SessionState = "idle" | "running" | "interrupting" | "disposed";

export type SessionInitialization = {
  process: JsonlProcess;
  promise: Promise<void>;
};

export type PendingNotice = {
  text: string;
  resolve(): void;
  reject(error: Error): void;
};
