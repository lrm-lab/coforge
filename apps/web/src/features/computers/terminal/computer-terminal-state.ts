import { TERMINAL_MAX_CHUNK_BYTES } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import type { SendTerminalInputResult } from "#src/server/computers/computer-terminal.server";

export type TerminalUiStatus =
  | "connecting"
  | "connected"
  | "needs_upgrade"
  | "disconnected"
  | "unauthorized"
  | "unsupported";

export type TerminalNotice =
  | { kind: "conflict" }
  | { kind: "history_unavailable" }
  | { kind: "output_backpressure" }
  | { kind: "daemon_replaced" }
  | { kind: "unauthorized" }
  | { kind: "spawn_failed" }
  | { kind: "snapshot_gap" }
  | { kind: "disconnected" }
  | { kind: "exited_code"; code: number }
  | { kind: "exited_signal"; signal: string };

export type ComputerTerminalStatusResult =
  | { unauthorized: true }
  | {
      unauthorized?: false;
      enabled: boolean;
      status: "ready" | "needs_upgrade" | "disconnected" | "unsupported";
      hasActiveSession: boolean;
      hasActiveAttach: boolean;
      platform: string | null;
    };

export function deriveStatusFromSnapshot(snapshot: ComputerTerminalStatusResult): TerminalUiStatus {
  if (snapshot.unauthorized) return "unauthorized";
  if (snapshot.status === "unsupported") return "unsupported";
  if (snapshot.status === "needs_upgrade") return "needs_upgrade";
  return "disconnected";
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x4000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
    let part = "";
    for (let index = 0; index < slice.byteLength; index += 1) {
      part += String.fromCharCode(slice[index]!);
    }
    binary += part;
  }
  return btoa(binary);
}

export function splitBytesIntoTerminalChunks(
  bytes: Uint8Array,
  maxBytes = TERMINAL_MAX_CHUNK_BYTES,
): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  const limit = Math.max(4, Math.min(maxBytes, TERMINAL_MAX_CHUNK_BYTES));
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(bytes.byteLength, offset + limit);
    if (end < bytes.byteLength) {
      let candidate = end;
      while (candidate > offset && (bytes[candidate]! & 0xc0) === 0x80) {
        candidate -= 1;
      }
      if (candidate > offset) end = candidate;
    }
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

export function chunkTerminalInput(
  text: string,
  maxBytes = TERMINAL_MAX_CHUNK_BYTES,
): Uint8Array[] {
  if (!text) return [];
  return splitBytesIntoTerminalChunks(new TextEncoder().encode(text), maxBytes);
}

function takeMergedChunk(queue: Uint8Array[], maxBytes: number): Uint8Array | undefined {
  if (queue.length === 0) return undefined;
  const first = queue[0]!;
  if (first.byteLength > maxBytes) {
    const [head, rest] = splitAtUtf8Boundary(first, maxBytes);
    if (rest.byteLength > 0) queue[0] = rest;
    else queue.shift();
    return head;
  }
  let total = 0;
  let takeCount = 0;
  while (takeCount < queue.length && total + queue[takeCount]!.byteLength <= maxBytes) {
    total += queue[takeCount]!.byteLength;
    takeCount += 1;
  }
  const taken = queue.splice(0, takeCount);
  if (taken.length === 1) return taken[0]!;
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const part of taken) {
    merged.set(part, cursor);
    cursor += part.byteLength;
  }
  return merged;
}

function splitAtUtf8Boundary(bytes: Uint8Array, maxBytes: number): [Uint8Array, Uint8Array] {
  const limit = Math.max(4, maxBytes);
  let end = Math.min(bytes.byteLength, limit);
  if (end < bytes.byteLength) {
    let candidate = end;
    while (candidate > 0 && (bytes[candidate]! & 0xc0) === 0x80) {
      candidate -= 1;
    }
    if (candidate > 0) end = candidate;
  }
  return [bytes.subarray(0, end), bytes.subarray(end)];
}

export class TerminalInputQueue {
  private nextInputSeq = 1;
  private pending: Uint8Array[] = [];
  private inFlight: { seq: number; httpSettled: boolean; daemonAccepted: boolean } | null = null;
  private generation = 0;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly ports: {
      send: (inputSeq: number, bytes: Uint8Array) => Promise<SendTerminalInputResult>;
      onFailure?: (error: unknown) => void;
      onSequenceMismatch?: (expectedInputSeq: number) => void;
    },
    private readonly maxChunkBytes = TERMINAL_MAX_CHUNK_BYTES,
  ) {}

  enqueue(text: string): void {
    if (!text) return;
    const encoded = this.encoder.encode(text);
    if (encoded.byteLength === 0) return;
    this.pending.push(encoded);
    void this.flush();
  }

  acknowledge(inputSeq: number): void {
    if (!this.inFlight || inputSeq !== this.inFlight.seq) return;
    this.inFlight.daemonAccepted = true;
    this.completeInFlightIfReady();
  }

  reset(): void {
    this.generation += 1;
    this.pending = [];
    this.inFlight = null;
    this.nextInputSeq = 1;
  }

  private completeInFlightIfReady(): void {
    if (!this.inFlight || !this.inFlight.httpSettled || !this.inFlight.daemonAccepted) return;
    this.inFlight = null;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.pending.length === 0) return;
    const bytes = takeMergedChunk(this.pending, this.maxChunkBytes);
    if (!bytes || bytes.byteLength === 0) return;

    const seq = this.nextInputSeq;
    const activeGeneration = this.generation;
    this.inFlight = { seq, httpSettled: false, daemonAccepted: false };

    try {
      const result = await this.ports.send(seq, bytes);
      if (activeGeneration !== this.generation || !this.inFlight || this.inFlight.seq !== seq) {
        return;
      }
      if (result.status === "accepted") {
        this.nextInputSeq = result.nextInputSeq;
        this.inFlight.httpSettled = true;
        this.completeInFlightIfReady();
        return;
      }
      if (result.status === "duplicate") {
        this.nextInputSeq = result.nextInputSeq;
        this.inFlight = null;
        void this.flush();
        return;
      }
      this.nextInputSeq = result.expectedInputSeq;
      this.pending = [];
      this.inFlight = null;
      this.ports.onSequenceMismatch?.(result.expectedInputSeq);
    } catch (error) {
      if (activeGeneration !== this.generation) return;
      this.reset();
      this.ports.onFailure?.(error);
    }
  }
}
