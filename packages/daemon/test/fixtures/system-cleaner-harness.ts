// The System Cleaner tests' shared driving: a manual clock, an App Inbox per owner under a
// temporary state root, injectable measurements and a period/idle helper.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppInbox, type AgentAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import {
  SystemCleaner,
  type CleanerClock,
  type DiskMeasurement,
  type MemoryMeasurement,
} from "#src/system-cleaner/system-cleaner";

export const KIB = 1024;
export const GIB = 1024 ** 3;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const OWNER = "agent-a";
export const MEMORY_ITEM = `cleaner:memory_size:${OWNER}`;
export const ACTIVE_CONTEXT_ITEM = `cleaner:active_context_size:${OWNER}`;
export const DISK_ITEM = `cleaner:disk_space:${OWNER}`;
export const PLENTY_OF_DISK: DiskMeasurement = {
  kind: "measured",
  availableBytes: 200 * GIB,
  totalBytes: 500 * GIB,
};
export const LOW_DISK: DiskMeasurement = {
  kind: "measured",
  availableBytes: 10 * GIB,
  totalBytes: 500 * GIB,
};

/** A manual clock: timers fire only when a test advances time past them. */
export class ManualClock implements CleanerClock {
  nowMs = 1_000_000;
  #nextId = 1;
  readonly #timers = new Map<number, { atMs: number; run: () => void }>();

  now() {
    return this.nowMs;
  }
  schedule(run: () => void, delayMs: number) {
    const id = this.#nextId++;
    this.#timers.set(id, { atMs: this.nowMs + delayMs, run });
    return id;
  }
  cancel(handle: unknown) {
    this.#timers.delete(handle as number);
  }
  pending() {
    return this.#timers.size;
  }
  advance(ms: number) {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.atMs <= target)
        .sort((left, right) => left[1].atMs - right[1].atMs)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.nowMs = due[1].atMs;
      due[1].run();
    }
    this.nowMs = target;
  }
}

const roots: string[] = [];

/** Registers a directory this test file made, so `cleanupHarnesses` removes it. */
export function trackRoot(path: string): void {
  roots.push(path);
}

/** Removes every directory a harness in this test file created; call it from `afterEach`. */
export function cleanupHarnesses(): Promise<void[]> {
  return Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function harness() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-system-cleaner-"));
  roots.push(stateDirectory);
  const clock = new ManualClock();
  const inboxes = new Map<string, Promise<AgentAppInbox>>();
  const inbox = (agentId: string) => {
    const existing = inboxes.get(agentId);
    if (existing) return existing;
    const opened = AgentAppInbox.open(stateDirectory, "workspace-a", agentId);
    inboxes.set(agentId, opened);
    return opened;
  };
  // Each file a fresh session carries is measured by its own path; `activeContext` starts at
  // zero so the tests that only care about MEMORY.md see no second hint.
  const measured = {
    memory: 0 as number | undefined,
    activeContext: 0 as number | undefined,
    disk: PLENTY_OF_DISK,
  };
  const measuredPaths: string[] = [];
  const wakes: { agentId: string; itemId: string }[] = [];
  const cleaner = new SystemCleaner({
    agentsDirectory: "/agents-root",
    clock,
    measureMemoryFile: async (path): Promise<MemoryMeasurement> => {
      measuredPaths.push(path);
      const bytes = path.endsWith("notes/active-context.md")
        ? measured.activeContext
        : measured.memory;
      return bytes === undefined
        ? { kind: "not_established", reason: "missing" }
        : { kind: "measured", bytes };
    },
    measureDiskSpace: async () => measured.disk,
    inbox: {
      upsert: async (agentId, item) => (await inbox(agentId)).upsert(item),
      remove: async (agentId, itemId) => (await inbox(agentId)).remove(itemId),
    },
    wake: async (agentId, itemId) => {
      wakes.push({ agentId, itemId });
    },
  });
  const items = async (agentId = OWNER): Promise<AgentAppItem[]> => (await inbox(agentId)).list();
  /** Advances time an hour (one period) at a time, letting each period's measurements settle
   * before the next, as they do when real periods are an interval apart. */
  const period = async (ms = HOUR_MS) => {
    for (let remaining = ms; remaining > 0; remaining -= HOUR_MS) {
      clock.advance(Math.min(HOUR_MS, remaining));
      await cleaner.settled();
    }
  };
  const idle = async (agentId = OWNER) => {
    cleaner.onAgentWorkingToIdle(agentId);
    await cleaner.settled();
  };
  return { cleaner, clock, measured, measuredPaths, wakes, items, period, idle };
}

export const config = (overrides: Record<string, unknown> = {}) => ({
  appId: "system.cleaner",
  ownerAgentId: OWNER,
  enabled: true,
  thresholdBytes: 64 * KIB,
  activeContextThresholdBytes: 4 * KIB,
  intervalMs: HOUR_MS,
  revision: 1,
  ...overrides,
});
