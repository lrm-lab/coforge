import type { WakeHint } from "@lrm/coforge-sdk/agent";

export const WAKE_HEARTBEAT_MS = 25_000;
export const WAKE_REFRESH_DEBOUNCE_MS = 100;
export const WAKE_SAFETY_REFRESH_MS = 3 * 60 * 1000;
export const MAX_WAKE_STREAMS_PER_CREDENTIAL = 3;

export class WakeStreamLimit {
  private readonly open = new Map<string, number>();

  acquire(credentialId: string): (() => void) | undefined {
    const count = this.open.get(credentialId) ?? 0;
    if (count >= MAX_WAKE_STREAMS_PER_CREDENTIAL) return undefined;
    this.open.set(credentialId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(credentialId) ?? 1) - 1;
      if (left <= 0) this.open.delete(credentialId);
      else this.open.set(credentialId, left);
    };
  }
}

export type WakeStreamDeps = {
  listHints: () => Promise<WakeHint[]>;
  subscribe: (listener: () => void) => () => void;
  revalidate: () => Promise<boolean>;
  release: () => void;
  heartbeatMs?: number;
  safetyRefreshMs?: number;
  debounceMs?: number;
};

const encoder = new TextEncoder();

const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const keyOf = (hint: WakeHint) => `${hint.channelId}|${hint.target ?? ""}`;

export function openWakeStream(
  deps: WakeStreamDeps,
  aborted: AbortSignal,
): ReadableStream<Uint8Array> {
  const heartbeatMs = deps.heartbeatMs ?? WAKE_HEARTBEAT_MS;
  const debounceMs = deps.debounceMs ?? WAKE_REFRESH_DEBOUNCE_MS;
  const safetyRefreshMs = deps.safetyRefreshMs ?? WAKE_SAFETY_REFRESH_MS;
  let lastRefreshAt = Date.now();
  const sent = new Map<string, bigint>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let dirty = false;
  let initial = true;

  const shutdown = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(debounce);
    unsubscribe?.();
    deps.release();
  };
  const close = () => {
    shutdown();
    try {
      controller.close();
    } catch {
      return;
    }
  };
  const push = (event: string, data: unknown) => {
    if (!closed) controller.enqueue(frame(event, data));
  };

  const refresh = async (snapshot: boolean) => {
    if (refreshing) {
      dirty = true;
      return;
    }
    refreshing = true;
    try {
      do {
        dirty = false;
        lastRefreshAt = Date.now();
        const hints = await deps.listHints();
        if (closed) return;
        const fresh: WakeHint[] = [];
        const next = new Map<string, bigint>();
        for (const hint of hints) {
          const key = keyOf(hint);
          const seq = BigInt(hint.latestSeq);
          next.set(key, seq);
          const before = sent.get(key);
          if (!snapshot && (before === undefined || seq > before)) fresh.push(hint);
        }
        sent.clear();
        for (const [key, seq] of next) sent.set(key, seq);
        if (snapshot) push("hints", { hints });
        for (const hint of fresh) push("hint", hint);
        snapshot = false;
      } while (dirty);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "external_agent.wake_refresh_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      if (initial) close();
    } finally {
      initial = false;
      refreshing = false;
    }
  };

  const onSignal = () => {
    if (closed || debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      void refresh(false);
    }, debounceMs);
  };

  const beat = async () => {
    const usable = await deps.revalidate().catch(() => true);
    if (closed) return;
    if (!usable) {
      close();
      return;
    }
    push("heartbeat", { at: new Date().toISOString() });
    if (Date.now() - lastRefreshAt >= safetyRefreshMs) void refresh(false);
  };

  return new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      if (aborted.aborted) {
        close();
        return;
      }
      aborted.addEventListener("abort", close, { once: true });
      try {
        unsubscribe = deps.subscribe(onSignal);
        heartbeat = setInterval(() => void beat(), heartbeatMs);
        await refresh(true);
      } catch (error) {
        shutdown();
        throw error;
      }
    },
    cancel() {
      aborted.removeEventListener("abort", close);
      shutdown();
    },
  });
}
