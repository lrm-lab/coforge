import { expect, test } from "bun:test";
import { decodeAgentLabelListResponse, type AgentLabel } from "./labels";

const label = (over: Partial<AgentLabel> = {}): AgentLabel => ({
  id: "lbl-1",
  name: "Bug",
  color: "error",
  description: "Something broken",
  groupId: "grp-1",
  archivedAt: null,
  group: { id: "grp-1", name: "Type", nameKey: "type", selection: "single" },
  openCount: 2,
  taskCount: 5,
  lastUsedAt: "2026-11-03T12:00:00.000Z",
  ...over,
});

test("decodes a label list, an empty one included", () => {
  const labels = [label(), label({ id: "lbl-2", name: "solo", group: null, groupId: null })];
  expect(decodeAgentLabelListResponse({ ok: true, labels })).toEqual({ ok: true, labels });
  expect(decodeAgentLabelListResponse({ ok: true, labels: [] })).toEqual({
    ok: true,
    labels: [],
  });
});

test("refuses a malformed envelope or label row", () => {
  for (const value of [
    undefined,
    {},
    { ok: true },
    { ok: true, labels: {} },
    { ok: false, labels: [] },
    { ok: true, labels: [{ ...label(), archivedAt: 3 }] },
    { ok: true, labels: [{ ...label(), group: { id: "g" } }] },
    { ok: true, labels: [{ ...label(), openCount: "2" }] },
  ])
    expect(() => decodeAgentLabelListResponse(value)).toThrow("invalid Agent label list response");
});
