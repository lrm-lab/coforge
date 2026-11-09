import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CONTEXT_INDEX_MAX_BYTES,
  AGENT_CONTEXT_VIEW_OFF_GRACE_MS,
  ContextViewStore,
} from "#src/agent-context-view/context-view-store";

const entry = {
  messageId: "message-1",
  sentAt: new Date(1_000).toISOString(),
  runtime: "codex" as const,
  sessionId: "session-1",
  transcript: "native/session.jsonl",
  offset: 42,
};

describe("ContextViewStore", () => {
  test("records and finds a bounded message offset", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const store = new ContextViewStore(root, "server-1", "agent-1", () => 2_000);
    store.record(entry);
    expect(store.find("message-1")).toEqual(entry);
  });

  test("compacts old entries and enforces the index cap", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const now = 31 * 24 * 60 * 60 * 1000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    store.record(entry);
    expect(store.compact(30)).toBe(0);
    expect(store.lookup("message-1")).toEqual({ status: "expired" });
    const current = { ...entry, messageId: "message-2", sentAt: new Date(now).toISOString() };
    store.record(current);
    expect(store.lookup("message-2")).toEqual({ status: "found", entry: current });
    expect(store.lookup("message-3")).toEqual({ status: "not_recorded" });
    expect(readFileSync(store.indexPath).length).toBeLessThanOrEqual(AGENT_CONTEXT_INDEX_MAX_BYTES);
  });

  test("retains an expired lookup after off-grace cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const store = new ContextViewStore(root, "server-1", "agent-1", () => 1_000);
    store.record(entry);
    store.markOff();
    expect(store.sweepOff(1_000 + AGENT_CONTEXT_VIEW_OFF_GRACE_MS)).toBe(true);
    expect(store.lookup("message-1")).toEqual({ status: "expired" });
    expect(store.lookup("message-2")).toEqual({ status: "not_recorded" });
  });

  test("keeps disabled data for 24 hours and rejects symlinked state", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const store = new ContextViewStore(root, "server-1", "agent-1", () => 1_000);
    store.record(entry);
    store.markOff();
    expect(store.sweepOff(1_000 + AGENT_CONTEXT_VIEW_OFF_GRACE_MS - 1)).toBe(false);
    expect(store.sweepOff(1_000 + AGENT_CONTEXT_VIEW_OFF_GRACE_MS)).toBe(true);
    const unsafe = join(root, "unsafe");
    symlinkSync(root, unsafe);
    expect(() => new ContextViewStore(unsafe, "server-1", "agent-1")).toThrow();
  });
});
