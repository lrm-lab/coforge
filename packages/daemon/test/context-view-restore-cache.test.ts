import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextViewRestoreCache } from "#src/agent-context-view/context-view-restore-cache";
import type { ContextViewRestoreResult } from "#src/agent-context-view/context-view-restore";

function restoredView(): ContextViewRestoreResult {
  return {
    ok: true,
    view: {
      runtime: "codex",
      sessionId: "sess-1",
      messageId: "msg-1",
      messages: [],
      source: { kind: "native", format: "jsonl" },
      redactions: { media: 0, diagnostic: 0 },
      responseFound: true,
      digestMatch: true,
      verification: "verified",
    },
  };
}

describe("ContextViewRestoreCache", () => {
  test("stores sourceBytes without retaining raw source buffers and invalidates on file change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-cache-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "first-line\n");
      let now = 1_000;
      const cache = new ContextViewRestoreCache(() => now, { ttlMs: 5_000, maxEntries: 4 });

      cache.set({ key: "k1", path: file, allowedRoots: [dir] }, 1024 * 1024, restoredView());

      expect(cache.size).toBe(1);
      const hit = cache.get({ key: "k1", path: file, allowedRoots: [dir] });
      expect(hit).toBeDefined();
      expect(hit?.sourceBytes).toBe(1024 * 1024);
      expect("source" in (hit as Record<string, unknown>)).toBe(false);
      expect(hit?.restored.ok).toBe(true);

      writeFileSync(file, "first-line\nsecond-line-longer\n");
      expect(cache.get({ key: "k1", path: file, allowedRoots: [dir] })).toBeUndefined();
      expect(cache.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("actively evicts expired entries via timer without waiting for a future get and cancels timer on clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-cache-ttl-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "line\n");
      let now = 10_000;
      const scheduled: { id: number; delayMs: number; callback: () => void; cleared: boolean }[] =
        [];
      let nextId = 1;
      const cache = new ContextViewRestoreCache(() => now, {
        ttlMs: 5_000,
        maxEntries: 8,
        setTimer: (callback, delayMs) => {
          const entry = { id: nextId++, delayMs, callback, cleared: false };
          scheduled.push(entry);
          return entry as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (handle) => {
          (handle as unknown as { cleared: boolean }).cleared = true;
        },
      });

      cache.set({ key: "k1", path: file, allowedRoots: [dir] }, 500, restoredView());
      now = 12_000;
      cache.set({ key: "k2", path: file, allowedRoots: [dir] }, 600, restoredView());
      expect(cache.size).toBe(2);
      expect(scheduled[0]?.delayMs).toBe(5_000);

      now = 15_000;
      scheduled[0]!.callback();
      expect(cache.size).toBe(1);
      expect(cache.get({ key: "k1", path: file, allowedRoots: [dir] })).toBeUndefined();

      const reschedule = scheduled.at(-1)!;
      expect(reschedule.cleared).toBe(false);
      expect(reschedule.delayMs).toBe(2_000);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(reschedule.cleared).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not retain entries or arm timers when ttlMs <= 0 or maxEntries <= 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-cache-disabled-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "line\n");
      let timersArmed = 0;
      const setTimer = (callback: () => void, _delayMs: number) => {
        timersArmed += 1;
        return callback as unknown as ReturnType<typeof setTimeout>;
      };
      const zeroTtl = new ContextViewRestoreCache(() => 1_000, { ttlMs: 0, setTimer });
      zeroTtl.set({ key: "k1", path: file, allowedRoots: [dir] }, 128, restoredView());
      expect(zeroTtl.size).toBe(0);

      const zeroCap = new ContextViewRestoreCache(() => 1_000, { maxEntries: 0, setTimer });
      zeroCap.set({ key: "k2", path: file, allowedRoots: [dir] }, 128, restoredView());
      expect(zeroCap.size).toBe(0);
      expect(timersArmed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
