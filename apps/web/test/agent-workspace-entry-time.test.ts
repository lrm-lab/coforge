import { expect, test } from "bun:test";
import { workspaceEntryTime } from "#src/features/agents/profile-panel/agent-workspace-entry-time";
import { formatRelativeTime } from "#src/lib/dates";

const now = new Date("2026-11-16T12:00:00Z");

test("a file shows when it last changed", () => {
  const modifiedAtMs = now.getTime() - 2 * 60 * 60 * 1000;
  expect(workspaceEntryTime({ type: "file", modifiedAtMs }, now, "en")).toBe(
    formatRelativeTime(new Date(modifiedAtMs), now, "en"),
  );
});

test("a folder and a file with no known time show nothing", () => {
  expect(
    workspaceEntryTime({ type: "dir", modifiedAtMs: now.getTime() }, now, "en"),
  ).toBeUndefined();
  expect(workspaceEntryTime({ type: "file", modifiedAtMs: 0 }, now, "en")).toBeUndefined();
});
