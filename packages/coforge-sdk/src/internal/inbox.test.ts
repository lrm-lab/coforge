import { expect, test } from "bun:test";
import {
  decodeInboxResponse,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  encodeLocalInboxRequest,
} from "./index";

test("round trips the version-compatible unified Inbox protocol", () => {
  expect(
    decodeLocalInboxRequest(
      encodeLocalInboxRequest({ idempotencyKey: "r", context: "c", operation: "check" }),
    ),
  ).toEqual({ idempotencyKey: "r", context: "c", operation: "check" });
  const response = {
    idempotencyKey: "r",
    accepted: true,
    entries: [
      {
        kind: "app" as const,
        app: {
          itemId: "reminder:id:1",
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: { kind: "reminder", id: "id", revision: "1" },
          title: "Due",
          summary: "Now",
          retention: "until_explicit_ack" as const,
          action: { kind: "run_command" as const, commandId: "reminder.ack" },
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      },
    ],
    seals: [],
  };
  expect(decodeInboxResponse(encodeInboxResponse(response))).toEqual(response);
});

test("round trips a transient System Cleaner item", () => {
  const response = {
    idempotencyKey: "r",
    accepted: true,
    entries: [
      {
        kind: "app" as const,
        app: {
          itemId: "cleaner:memory_size:agent-a",
          appId: "system.cleaner",
          notificationClass: "memory_size",
          sourceRef: { kind: "memory_size", id: "agent-a", revision: "0" },
          title: "MEMORY.md is 70.0 KiB, over 64.0 KiB; recheck in 1h",
          retention: "transient" as const,
          action: { kind: "run_command" as const, commandId: "app.config" },
          createdAt: "2026-10-16T00:00:00.000Z",
        },
      },
    ],
    seals: [],
  };
  expect(decodeInboxResponse(encodeInboxResponse(response))).toEqual(response);
});

test("round trips when the newest pending message was created, and leaves it unset otherwise", () => {
  const entry = (latestCreatedAtMs?: number) => ({
    kind: "message_target" as const,
    messageTarget: {
      target: "#general",
      pendingCount: 2,
      firstPendingSequence: 3,
      latestSequence: 4,
      ...(latestCreatedAtMs === undefined ? {} : { latestCreatedAtMs }),
      flags: ["channel"],
    },
  });
  const response = {
    idempotencyKey: "r",
    accepted: true,
    entries: [entry(1_700_000_000_123), entry()],
    seals: [],
  };
  const decoded = decodeInboxResponse(encodeInboxResponse(response));
  expect(decoded).toEqual(response);
  expect(
    "latestCreatedAtMs" in (decoded.entries[1] as ReturnType<typeof entry>).messageTarget,
  ).toBe(false);
  expect(() => encodeInboxResponse({ ...response, entries: [entry(-1)] })).toThrow(
    "invalid message attention time",
  );
});

test("round trips a sealed source identity with and without a revision", () => {
  const response = {
    idempotencyKey: "r",
    accepted: true,
    entries: [],
    seals: [
      {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: {
          kind: "reminder",
          id: "123e4567-e89b-42d3-a456-426614174000",
          revision: "3",
        },
        owner: "@ada",
        until: "the deploy lands",
        sealedAt: "2026-11-03T10:00:00.000Z",
        state: "SEALED" as const,
        liveRevision: "3",
      },
      {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000" },
        owner: "@ada",
        until: "the deploy lands",
        sealedAt: "2026-11-03T10:00:00.000Z",
        state: "DETACHED" as const,
      },
    ],
  };
  expect(decodeInboxResponse(encodeInboxResponse(response))).toEqual(response);
});
