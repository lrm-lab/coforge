import { expect, test } from "bun:test";
import type { AgentLabel, AgentLabelListResponse } from "@lrm/coforge-sdk/agent";
import { parseArgs, run } from "../index";

const transport = (response: AgentLabelListResponse) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  labelList: async () => response,
});

const label = (over: Partial<AgentLabel> = {}): AgentLabel => ({
  id: "lbl-1",
  name: "Bug",
  color: "error",
  description: null,
  groupId: null,
  archivedAt: null,
  group: null,
  openCount: 2,
  taskCount: 5,
  lastUsedAt: "2026-11-03T12:00:00.000Z",
  ...over,
});

test("label list takes no arguments but --json", () => {
  expect(parseArgs(["label", "list"])).toEqual({ command: "label-list" });
  expect(parseArgs(["label", "list", "--json"])).toEqual({
    command: "label-list",
    json: true,
  });
  expect(() => parseArgs(["label"])).toThrow("Usage: coforge label list");
  expect(() => parseArgs(["label", "list", "Bug"])).toThrow("Usage: coforge label list");
});

test("lists each label with its counts, group, last use and archived state", async () => {
  const output = await run(
    ["label", "list"],
    transport({
      ok: true,
      labels: [
        label({
          name: "Bug",
          description: "Something broken",
          groupId: "g1",
          group: { id: "g1", name: "Type", nameKey: "type", selection: "single" },
        }),
        label({ id: "lbl-2", name: "old", archivedAt: "2026-11-01T00:00:00.000Z" }),
      ],
    }),
  );
  expect(output).toBe(
    [
      "Labels (2):",
      "- Bug (color=error, open=2, tasks=5, group=Type, lastUsedAt=2026-11-03T12:00:00.000Z) — Something broken",
      "- old (color=error, open=2, tasks=5, lastUsedAt=2026-11-03T12:00:00.000Z, archived)",
    ].join("\n"),
  );
});

test("--json returns the response", async () => {
  const body: AgentLabelListResponse = { ok: true, labels: [label()] };
  expect(await run(["label", "list", "--json"], transport(body))).toBe(body);
});

test("says so when the Workspace has no labels", async () => {
  expect(await run(["label", "list"], transport({ ok: true, labels: [] }))).toBe("No labels.");
});
