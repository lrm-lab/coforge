import type { PiChatScope, PiChatEvent } from "@lrm/coforge-sdk/internal/pi-chat";
import {
  piChatFrames,
  type PiChatRequest,
  type PiChatFrame,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { PiChatWorkers } from "./workers";

/** Commands receive replies; live observations are bounded and repaired from native history. */
export class PiChatRelay {
  readonly #workers: PiChatWorkers;
  readonly #events: PiChatFrame[][] = [];
  #queuedBytes = 0;
  #sending = false;
  #closed = false;
  constructor(
    binding: Pick<PiChatScope, "workspaceId" | "computerId">,
    private readonly send: (frame: PiChatFrame) => Promise<void>,
    options: { command?: string[] } = {},
  ) {
    this.#workers = new PiChatWorkers(
      binding,
      (event, scope) => this.#observe(event, scope),
      options,
    );
  }
  async execute(request: PiChatRequest) {
    let response: unknown;
    try {
      response = { result: await this.#workers.execute(request, request.command) };
    } catch {
      response = { error: "Pi chat request failed" };
    }
    if (this.#closed) return;
    let frames: PiChatFrame[];
    try {
      frames = piChatFrames(request, request.requestId, "result", response);
    } catch {
      frames = piChatFrames(request, request.requestId, "result", {
        error: "Pi chat result exceeds the 32 MB limit",
      });
    }
    for (const frame of frames) await this.send(frame);
  }
  #observe(event: PiChatEvent, scope: PiChatScope) {
    if (this.#closed) return;
    try {
      const frames = piChatFrames(scope, crypto.randomUUID(), "event", event);
      const size = frames.reduce((sum, frame) => sum + frame.data.length, 0);
      if (this.#events.length >= 64 || this.#queuedBytes + size > 32_000_000) return;
      this.#events.push(frames);
      this.#queuedBytes += size;
      void this.#flush();
    } catch {
      /* Oversized observations remain available in native paged history. */
    }
  }
  async #flush() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (!this.#closed && this.#events.length) {
        const frames = this.#events.shift()!;
        this.#queuedBytes -= frames.reduce((sum, frame) => sum + frame.data.length, 0);
        try {
          for (const frame of frames) await this.send(frame);
        } catch {
          /* No retry/outbox: reconnect and the watchdog read native history. */
        }
      }
    } finally {
      this.#sending = false;
    }
  }
  async close() {
    this.#closed = true;
    this.#events.length = 0;
    this.#queuedBytes = 0;
    await this.#workers.close();
  }
}
