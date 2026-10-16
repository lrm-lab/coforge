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
  };
  expect(decodeInboxResponse(encodeInboxResponse(response))).toEqual(response);
});
