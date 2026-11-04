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
  expect(parseArgs(["label", "list"])).toEqual({ command: "label" });
  expect(parseArgs(["label", "list", "--json"])).toEqual({
    command: "label",
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

const record = { id: "lbl-1", name: "Bug", color: "error", description: "Something broken" };
const written = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  label: { ...record, groupId: null, archivedAt: null, group: null, ...over },
});

test("label create, rename, update, delete and restore parse to one label write", () => {
  expect(
    parseArgs(["label", "create", "Bug", "--description", "Something broken", "--color", "error"]),
  ).toEqual({
    command: "label",
    request: { operation: "create", name: "Bug", description: "Something broken", color: "error" },
  });
  expect(parseArgs(["label", "rename", "Bug", "--to", "Defect", "--json"])).toEqual({
    command: "label",
    request: { operation: "update", label: "Bug", name: "Defect" },
    json: true,
  });
  expect(parseArgs(["label", "update", "Bug", "--color", "error"])).toEqual({
    command: "label",
    request: { operation: "update", label: "Bug", color: "error" },
  });
  expect(parseArgs(["label", "delete", "Bug"])).toEqual({
    command: "label",
    request: { operation: "update", label: "Bug", archived: true },
  });
  expect(parseArgs(["label", "restore", "Bug"])).toEqual({
    command: "label",
    request: { operation: "update", label: "Bug", archived: false },
  });
});

test("a label write refuses a missing name, a missing change or a stray flag", () => {
  for (const args of [
    ["label", "create", "--description", "x"],
    ["label", "create", "Bug"],
    ["label", "create", "Bug", "--description", "  "],
    ["label", "rename", "Bug"],
    ["label", "rename", "--to", "Defect"],
    ["label", "update", "Bug"],
    ["label", "delete"],
    ["label", "delete", "Bug", "--to", "x"],
    ["label", "restore", "Bug", "Other"],
    ["label", "update", "Bug", "--color"],
    ["label", "archive", "Bug"],
  ])
    expect(() => parseArgs(args)).toThrow("Usage: coforge label");
});

test("each label write says what it did, and --json returns the response", async () => {
  const sent: unknown[] = [];
  const writer = (over: Record<string, unknown> = {}) => ({
    ...transport({ ok: true, labels: [] }),
    labelWrite: async (request: unknown) => {
      sent.push(request);
      return written(over);
    },
  });
  expect(await run(["label", "create", "Bug", "--description", "Something broken"], writer())).toBe(
    "Label Bug (color=error) — Something broken",
  );
  expect(await run(["label", "rename", "Bug", "--to", "Defect"], writer({ name: "Defect" }))).toBe(
    "Renamed Bug to Defect.",
  );
  expect(await run(["label", "update", "Bug", "--color", "error"], writer())).toBe(
    "Label Bug is now error.",
  );
  expect(
    await run(["label", "delete", "Bug"], writer({ archivedAt: "2026-11-04T07:00:00.000Z" })),
  ).toBe(
    "Deleted Bug (archived): tasks no longer show it and it cannot be attached; `coforge label restore Bug` brings it back.",
  );
  expect(await run(["label", "restore", "Bug"], writer())).toBe("Restored Bug.");
  expect(await run(["label", "restore", "Bug", "--json"], writer())).toEqual(written());
  expect(sent).toHaveLength(6);
});
