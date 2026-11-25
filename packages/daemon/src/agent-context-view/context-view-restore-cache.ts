import type { ContextViewRestoreResult } from "./context-view-restore";
import {
  contextViewSourceMaxBytes,
  fingerprintContextViewSource,
  type ContextViewSourceFingerprint,
} from "./context-view-source";

const DEFAULT_TTL_MS = 5_000;
const MAX_ENTRIES = 8;

type TimerHandle = ReturnType<typeof setTimeout>;

type Cached = {
  key: string;
  path: string;
  fingerprint: ContextViewSourceFingerprint;
  sourceBytes: number;
  restored: ContextViewRestoreResult;
  expiresAt: number;
};

type CacheInput = {
  key: string;
  path: string;
  allowedRoots: readonly string[];
  maxSourceBytes?: number;
};

export type ContextViewRestoreCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

function defaultSetTimer(callback: () => void, delayMs: number): TimerHandle {
  const handle = setTimeout(callback, delayMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) handle.unref();
  return handle;
}

function sameFingerprint(
  a: ContextViewSourceFingerprint,
  b: ContextViewSourceFingerprint,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function cloneResult(result: ContextViewRestoreResult): ContextViewRestoreResult {
  return structuredClone(result);
}

export class ContextViewRestoreCache {
  readonly #entries = new Map<string, Cached>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  #expiryTimer: TimerHandle | undefined;
  #expiryScheduledAt: number | undefined;

  constructor(now: () => number = Date.now, options: ContextViewRestoreCacheOptions = {}) {
    this.#now = now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.#setTimer = options.setTimer ?? defaultSetTimer;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
    this.#cancelTimer();
  }

  get(input: CacheInput): { sourceBytes: number; restored: ContextViewRestoreResult } | undefined {
    const now = this.#now();
    const cached = this.#entries.get(input.key);
    if (!cached || cached.path !== input.path || cached.expiresAt <= now) {
      if (cached) {
        this.#entries.delete(input.key);
        this.#syncTimer(now);
      }
      return undefined;
    }
    const fingerprint = fingerprintContextViewSource(
      input.path,
      input.allowedRoots,
      input.maxSourceBytes ?? contextViewSourceMaxBytes(),
    );
    if (!fingerprint || !sameFingerprint(fingerprint, cached.fingerprint)) {
      this.#entries.delete(input.key);
      this.#syncTimer(now);
      return undefined;
    }
    this.#entries.delete(input.key);
    cached.expiresAt = now + this.#ttlMs;
    this.#entries.set(input.key, cached);
    this.#syncTimer(now);
    return {
      sourceBytes: cached.sourceBytes,
      restored: cloneResult(cached.restored),
    };
  }

  set(input: CacheInput, sourceBytes: number, restored: ContextViewRestoreResult): void {
    if (!restored.ok || this.#ttlMs <= 0 || this.#maxEntries <= 0) return;
    const now = this.#now();
    this.#pruneExpired(now);
    const fingerprint = fingerprintContextViewSource(
      input.path,
      input.allowedRoots,
      input.maxSourceBytes ?? contextViewSourceMaxBytes(),
    );
    if (!fingerprint) {
      this.#syncTimer(now);
      return;
    }
    this.#entries.delete(input.key);
    this.#entries.set(input.key, {
      key: input.key,
      path: input.path,
      fingerprint,
      sourceBytes,
      restored: cloneResult(restored),
      expiresAt: now + this.#ttlMs,
    });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#syncTimer(now);
  }

  #pruneExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  #cancelTimer(): void {
    if (this.#expiryTimer !== undefined) {
      this.#clearTimer(this.#expiryTimer);
      this.#expiryTimer = undefined;
      this.#expiryScheduledAt = undefined;
    }
  }

  #syncTimer(now: number): void {
    if (this.#entries.size === 0 || this.#ttlMs <= 0) {
      this.#cancelTimer();
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.#entries.values()) {
      if (entry.expiresAt < earliest) earliest = entry.expiresAt;
    }
    if (this.#expiryTimer !== undefined && this.#expiryScheduledAt === earliest) return;
    this.#cancelTimer();
    this.#expiryScheduledAt = earliest;
    this.#expiryTimer = this.#setTimer(
      () => {
        this.#expiryTimer = undefined;
        this.#expiryScheduledAt = undefined;
        const tickNow = this.#now();
        this.#pruneExpired(tickNow);
        this.#syncTimer(tickNow);
      },
      Math.max(0, earliest - now),
    );
  }
}
