import { expect, test } from "bun:test";
import { resolveReminderId } from "../index";

test("resolveReminderId matches a dash-stripped id prefix, and rejects zero or many matches", async () => {
  const first = {
    reminderId: "12345678-1234-4123-8123-123456789abc",
    ownerAgentId: "agent",
    version: 1,
    title: "First",
    target: "#g",
    messageId: "deadbeef",
    fireAt: "2026-09-09T00:00:00Z",
    status: "scheduled" as const,
    createdAt: "2026-09-08T00:00:00Z",
  };
  const second = {
    ...first,
    reminderId: "12345679-1234-4123-8123-123456789abc",
    title: "Second",
  };
  const scopeFields = {
    idempotencyKey: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const calls: unknown[] = [];
  const listing = (reminders: (typeof first)[]) => ({
    reminder: async (request: unknown) => {
      calls.push(request);
      return { ...scopeFields, accepted: true, events: [], reminders };
    },
  });
  await expect(resolveReminderId(listing([first, second]), "123456781234")).resolves.toBe(
    first.reminderId,
  );
  expect(calls.at(-1)).toEqual({ operation: "list", all: true });
  await expect(resolveReminderId(listing([]), "ffffffff")).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "No reminder matches id prefix 'ffffffff'.",
  });
  const ambiguousFirst = { ...first, reminderId: "aaaaaaaa-1111-4111-8111-111111111111" };
  const ambiguousSecond = { ...first, reminderId: "aaaaaaaa-2222-4222-8222-222222222222" };
  await expect(
    resolveReminderId(listing([ambiguousFirst, ambiguousSecond]), "aaaaaaaa"),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS",
    message: "Ambiguous id prefix 'aaaaaaaa' matches 2 reminders; pass a longer id.",
  });
});

test("resolveReminderId scopes the lookup to scheduled/fired for cancel/snooze, and names that scope in NOT_FOUND", async () => {
  const calls: unknown[] = [];
  const scopeFields = {
    idempotencyKey: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const transport = {
    reminder: async (request: unknown) => {
      calls.push(request);
      return { ...scopeFields, accepted: true, events: [], reminders: [] };
    },
  };
  await expect(
    resolveReminderId(transport, "ffffffff", { statuses: ["scheduled", "fired"] }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "No scheduled/fired reminder matches id prefix 'ffffffff'.",
  });
  expect(calls).toEqual([{ operation: "list", status: "scheduled,fired" }]);
});
