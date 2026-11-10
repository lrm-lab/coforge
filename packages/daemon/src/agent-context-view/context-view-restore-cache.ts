import type { ContextViewRestoreResult } from "./context-view-restore";
import {
  contextViewSourceMaxBytes,
  fingerprintContextViewSource,
  type ContextViewSourceFingerprint,
} from "./context-view-source";

const DEFAULT_TTL_MS = 5_000;
const MAX_ENTRIES = 8;

type Cached = {
  key: string;
  path: string;
  fingerprint: ContextViewSourceFingerprint;
  source: Buffer;
  restored: ContextViewRestoreResult;
  expiresAt: number;
};

type CacheInput = {
  key: string;
  path: string;
  allowedRoots: readonly string[];
  maxSourceBytes?: number;
};

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

/**
 * A tiny per-subscription cache for repeated reads of the same Context View message.
 *
 * The cache never crosses Agent/session keys, is bounded, expires quickly, and revalidates the
 * private source fingerprint before returning content. It is intentionally scoped to one query
 * subscription so restarting the query subscription drops every retained view.
 */
export class ContextViewRestoreCache {
  readonly #entries = new Map<string, Cached>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(now: () => number = Date.now, options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.#now = now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES;
  }

  get(
    input: CacheInput,
  ): { source: Buffer; sourceBytes: number; restored: ContextViewRestoreResult } | undefined {
    const cached = this.#entries.get(input.key);
    if (!cached || cached.path !== input.path || cached.expiresAt <= this.#now()) {
      if (cached) this.#entries.delete(input.key);
      return undefined;
    }
    const fingerprint = fingerprintContextViewSource(
      input.path,
      input.allowedRoots,
      input.maxSourceBytes ?? contextViewSourceMaxBytes(),
    );
    if (!fingerprint || !sameFingerprint(fingerprint, cached.fingerprint)) {
      this.#entries.delete(input.key);
      return undefined;
    }
    this.#entries.delete(input.key);
    cached.expiresAt = this.#now() + this.#ttlMs;
    this.#entries.set(input.key, cached);
    return {
      source: Buffer.from(cached.source),
      sourceBytes: cached.source.byteLength,
      restored: cloneResult(cached.restored),
    };
  }

  set(input: CacheInput, source: Buffer, restored: ContextViewRestoreResult): void {
    if (!restored.ok) return;
    const fingerprint = fingerprintContextViewSource(
      input.path,
      input.allowedRoots,
      input.maxSourceBytes ?? contextViewSourceMaxBytes(),
    );
    if (!fingerprint) return;
    this.#entries.delete(input.key);
    this.#entries.set(input.key, {
      key: input.key,
      path: input.path,
      fingerprint,
      source: Buffer.from(source),
      restored: cloneResult(restored),
      expiresAt: this.#now() + this.#ttlMs,
    });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
