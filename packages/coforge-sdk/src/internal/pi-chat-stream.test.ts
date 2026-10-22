import { expect, test } from "bun:test";
import { PiChatLiveHistory } from "./pi-chat-stream";
import type { PiChatEvent, PiChatResult } from "./pi-chat";

test("a history response started before a live update cannot erase thinking or tool output", () => {
  const sessionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  const snapshot: PiChatResult = {
    messages: [{ id: "u", role: "user", text: "hello" }],
    stream: { id, sequence: 0 },
  };
  const update: PiChatEvent = {
    sessionId,
    stream: { id, sequence: 1 },
    messages: [{ id: "streaming", role: "assistant", text: "partial", thinking: "thinking" }],
  };
  expect(live.accept(update)).toBe("changed");
  expect(live.merge(snapshot).messages?.at(-1)).toMatchObject({
    text: "partial",
    thinking: "thinking",
  });
  live.accept({
    sessionId,
    stream: { id, sequence: 2 },
    removeIds: ["streaming"],
    messages: [{ id: "a", role: "assistant", text: "finished" }],
  });
  expect(live.merge(snapshot).messages?.map((message) => message.id)).toEqual(["u", "a"]);
  expect(live.merge(snapshot).messages?.at(-1)?.text).toBe("finished");
  expect(live.accept(update)).toBe("ignored");
});
test("gaps and worker changes request native recovery; unrelated sessions do not corrupt the view", () => {
  const sessionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  live.merge({ stream: { id, sequence: 4 }, messages: [] });
  expect(live.accept({ sessionId: crypto.randomUUID(), stream: { id, sequence: 5 } })).toBe(
    "observed",
  );
  expect(live.accept({ sessionId, stream: { id, sequence: 7 }, messages: [] })).toBe("recover");
  const replacement = crypto.randomUUID();
  expect(live.accept({ sessionId, stream: { id: replacement, sequence: 1 }, messages: [] })).toBe(
    "recover",
  );
  expect(live.accept({ sessionId, stream: { id, sequence: 8 } })).toBe("ignored");
  expect(() => live.merge({ stream: { id, sequence: 7 } })).toThrow("replaced");
});

test("overflow requires a fresh native snapshot rather than accepting an incomplete replay", () => {
  const sessionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  for (let sequence = 1; sequence <= 513; sequence++)
    live.accept({ sessionId, stream: { id, sequence } });
  expect(() => live.merge({ stream: { id, sequence: 0 } })).toThrow("fresh");
  expect(live.merge({ stream: { id, sequence: 513 }, messages: [] }).messages).toEqual([]);
});
