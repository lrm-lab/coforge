import type { PageLevel } from "./artifact-page-levels";

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const REFUSED = -32000;

export type Params = Record<string, unknown>;

export class BridgeRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class PageHostError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export const isRecord = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type PageConfirm =
  | { kind: "link"; url: string }
  | { kind: "data"; paths: string[] }
  | { kind: "upload"; name: string; sizeBytes: number }
  | { kind: "delete"; name: string };

export type PageWriteRequest =
  | { op: "set" | "update"; collection: string; id: string; data?: unknown; ifVersion?: number }
  | { op: "delete"; collection: string; id: string; ifVersion?: number };

export type PageDataCall =
  | { method: "get"; collection: string; id: string }
  | { method: "query"; collection: string; query?: unknown }
  | { method: "write"; writes: PageWriteRequest[] };

export type PageDataPort = {
  call(call: PageDataCall): Promise<unknown>;
  subscribe(listener: (collection: string) => void): () => void;
};

export type PageAssetsPort = {
  list(): Promise<unknown>;
  upload(file: Blob, name: string): Promise<unknown>;
  delete(name: string): Promise<unknown>;
};

export type ConfirmGate = "links" | "data" | "assets";

export type BridgeKit = {
  level: PageLevel;
  data: PageDataPort;
  assets: PageAssetsPort;
  send(message: object): void;
  confirm(gate: ConfirmGate, request: PageConfirm, remember?: boolean): Promise<void>;
};

export type CallTable = Record<string, (args: Params) => Promise<unknown> | unknown>;

export async function viaHost<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    if (cause instanceof BridgeRefusal) throw cause;
    throw new BridgeRefusal(REFUSED, cause instanceof PageHostError ? cause.reason : "Failed");
  }
}

export const requireText = (value: unknown, what: string, max = 256): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new BridgeRefusal(INVALID_PARAMS, `${what} expected`);
  return value;
};
