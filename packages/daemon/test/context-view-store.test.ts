import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
    expect(existsSync(store.indexPath)).toBe(false);
    const current = { ...entry, messageId: "message-2", sentAt: new Date(now).toISOString() };
    store.record(current);
    expect(readFileSync(store.indexPath).length).toBeLessThanOrEqual(AGENT_CONTEXT_INDEX_MAX_BYTES);
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

  test("sweeps a private captured request log by retention and grace", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const log = join(root, "pi-requests.jsonl");
    writeFileSync(log, '{"type":"request"}\n', "utf8");
    utimesSync(log, new Date(1), new Date(1));
    expect(ContextViewStore.sweepRequestLog(log, 2_000)).toBe(true);
    writeFileSync(log, '{"type":"request"}\n', "utf8");
    const store = new ContextViewStore(root, "server-1", "agent-1", () => 1_000);
    store.record(entry);
    store.markOff(1_000);
    expect(ContextViewStore.removeRequestLog(log)).toBe(true);
    expect(store.sweepOff(1_000 + AGENT_CONTEXT_VIEW_OFF_GRACE_MS)).toBe(true);
  });

  test("uses a managed request-log directory and rejects a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-view-"));
    const store = new ContextViewStore(root, "server-1", "agent-1", () => 1_000);
    const directory = store.requestLogDirectory;
    expect(directory).toBe(join(root, "agent-context", "server-1", "agent-1", "pi-requests"));
    const outside = mkdtempSync(join(tmpdir(), "coforge-context-view-outside-"));
    rmdirSync(directory);
    symlinkSync(outside, directory);
    expect(() => store.requestLogDirectory).toThrow("Context view directory is a symlink");
  });
});
