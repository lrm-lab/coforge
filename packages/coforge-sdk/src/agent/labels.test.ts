import { expect, test } from "bun:test";
import {
  decodeAgentLabelListResponse,
  decodeAgentLabelWriteRequest,
  decodeAgentLabelWriteResponse,
  type AgentLabel,
} from "./labels";

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

test("a label write is create (name + description) or update (a label + one change)", () => {
  expect(
    decodeAgentLabelWriteRequest({ operation: "create", name: "Bug", description: "Broken" }),
  ).toEqual({ operation: "create", name: "Bug", description: "Broken" });
  expect(
    decodeAgentLabelWriteRequest({
      operation: "create",
      name: "Bug",
      description: "Broken",
      color: "error",
    }),
  ).toEqual({ operation: "create", name: "Bug", description: "Broken", color: "error" });
  expect(
    decodeAgentLabelWriteRequest({ operation: "update", label: "Bug", name: "Defect" }),
  ).toEqual({ operation: "update", label: "Bug", name: "Defect" });
  expect(
    decodeAgentLabelWriteRequest({ operation: "update", label: "Bug", archived: false }),
  ).toEqual({ operation: "update", label: "Bug", archived: false });
});

test("refuses a label write with a missing, unknown or mistyped field", () => {
  for (const value of [
    undefined,
    [],
    { operation: "delete", label: "Bug" },
    { operation: "create", name: "Bug" },
    { operation: "create", description: "Broken" },
    { operation: "create", name: "Bug", description: "Broken", archived: true },
    { operation: "update", label: "Bug" },
    { operation: "update", name: "Defect" },
    { operation: "update", label: "Bug", archived: "yes" },
    { operation: "update", label: "Bug", color: 3 },
    { operation: "update", label: "Bug", name: "Defect", groupId: "g" },
  ])
    expect(decodeAgentLabelWriteRequest(value)).toBeNull();
});

test("decodes the label a write answers with", () => {
  const { openCount: _open, taskCount: _tasks, lastUsedAt: _last, ...row } = label();
  expect(decodeAgentLabelWriteResponse({ ok: true, label: row })).toEqual({
    ok: true,
    label: row,
  });
  for (const value of [{ ok: true }, { ok: true, label: { ...row, name: 1 } }])
    expect(() => decodeAgentLabelWriteResponse(value)).toThrow(
      "invalid Agent label write response",
    );
});
