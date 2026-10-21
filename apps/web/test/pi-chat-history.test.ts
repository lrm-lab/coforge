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
