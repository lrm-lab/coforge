import { expect, test } from "bun:test";
import type { PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { loadPiChatHistory, preparePiChatSend } from "#src/features/pi-chat/pi-chat-state";

const page = (start: number, end: number): PiChatResult => ({
  before: start,
  messages: Array.from({ length: end - start }, (_, offset) => ({
    id: String(start + offset),
    role: "assistant",
    text: `message ${start + offset}`,
  })),
});

test("moving history windows retain prior messages and fill any gap between polls", async () => {
  const calls: (number | undefined)[] = [];
  const result = await loadPiChatHistory(page(50, 100), async (before) => {
    calls.push(before);
    return before === undefined ? page(150, 200) : page(Math.max(0, before - 50), before);
  });
  expect(calls).toEqual([undefined, 150, 100]);
  expect(result.messages?.map((message) => message.id)).toEqual(
    Array.from({ length: 150 }, (_, index) => String(index + 50)),
  );
  expect(result.before).toBe(50);
});

test("completed messages replace transient thinking/tool updates", async () => {
  const previous = page(0, 2);
  previous.messages!.push(
    { id: "streaming", role: "assistant", text: "partial" },
    { id: "running:tool", role: "tool", text: "partial" },
  );
  const result = await loadPiChatHistory(previous, async () => page(0, 3));
  expect(result.messages).toHaveLength(3);
  expect(result.messages?.some((message) => message.text === "partial")).toBe(false);
});

test("a retained draft reuses the accepted-send identity after switching conversations", () => {
  const first = preparePiChatSend({ text: " run tool " });
  const retained = JSON.parse(JSON.stringify(first));
  expect(preparePiChatSend(retained).request?.id).toBe(first.request?.id);
  expect(preparePiChatSend({ ...retained, text: "another request" }).request?.id).not.toBe(
    first.request?.id,
  );
});

test("Codex history uses native cursors to fill a gap before joining the cached transcript", async () => {
  const session = {
    id: crypto.randomUUID(),
    title: "Native",
    updatedAt: 0,
    status: "idle" as const,
    model: "Codex",
    requestIds: [],
    runtime: "codex" as const,
  };
  const result = await loadPiChatHistory(
    { ...page(1, 3), cursor: "older", session },
    async (_before, cursor) =>
      cursor
        ? { ...page(2, 5), cursor: "oldest", session }
        : { ...page(5, 7), cursor: "middle", session },
  );
  expect(result.messages?.map(({ id }) => id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(result.cursor).toBe("older");
});
