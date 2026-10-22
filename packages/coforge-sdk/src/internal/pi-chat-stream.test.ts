import { expect, test } from "bun:test";
import { PiChatLiveHistory } from "./pi-chat-stream";
import type { PiChatEvent, PiChatResult } from "./pi-chat";

test("a delayed initial snapshot cannot retire a newly observed worker", async () => {
  const sessionId = crypto.randomUUID();
  const old = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  const response = Promise.withResolvers<PiChatResult>();
  const pending = live.read(() => response.promise);
  live.accept({ sessionId, stream: { id: replacement, sequence: 1 } });
  response.resolve({ stream: { id: old, sequence: 0 }, messages: [] });
  await expect(pending).rejects.toThrow("replaced");
  expect(
    live.accept({
      sessionId,
      stream: { id: replacement, sequence: 2 },
      messages: [{ id: "streaming", role: "assistant", text: "still live" }],
    }),
  ).toBe("changed");
  const recovered = await live.read(async () => ({
    stream: { id: replacement, sequence: 1 },
    messages: [],
  }));
  expect(recovered.messages?.at(-1)?.text).toBe("still live");
});

test("a history response started before a live update cannot erase thinking or tool output", async () => {
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
  expect((await live.read(async () => snapshot)).messages?.at(-1)).toMatchObject({
    text: "partial",
    thinking: "thinking",
  });
  live.accept({
    sessionId,
    stream: { id, sequence: 2 },
    removeIds: ["streaming"],
    messages: [{ id: "a", role: "assistant", text: "finished" }],
  });
  expect((await live.read(async () => snapshot)).messages?.map((message) => message.id)).toEqual([
    "u",
    "a",
  ]);
  expect((await live.read(async () => snapshot)).messages?.at(-1)?.text).toBe("finished");
  expect(live.accept(update)).toBe("ignored");
});
test("gaps and worker changes request native recovery; unrelated sessions do not corrupt the view", async () => {
  const sessionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  await live.read(async () => ({ stream: { id, sequence: 4 }, messages: [] }));
  expect(live.accept({ sessionId: crypto.randomUUID(), stream: { id, sequence: 5 } })).toBe(
    "observed",
  );
  expect(live.accept({ sessionId, stream: { id, sequence: 7 }, messages: [] })).toBe("recover");
  const replacement = crypto.randomUUID();
  expect(live.accept({ sessionId, stream: { id: replacement, sequence: 1 }, messages: [] })).toBe(
    "recover",
  );
  expect(live.accept({ sessionId, stream: { id, sequence: 8 } })).toBe("ignored");
  await expect(live.read(async () => ({ stream: { id, sequence: 7 } }))).rejects.toThrow(
    "replaced",
  );
});

test("overflow requires a fresh native snapshot rather than accepting an incomplete replay", async () => {
  const sessionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const live = new PiChatLiveHistory(sessionId);
  for (let sequence = 1; sequence <= 513; sequence++)
    live.accept({ sessionId, stream: { id, sequence } });
  await expect(live.read(async () => ({ stream: { id, sequence: 0 } }))).rejects.toThrow("fresh");
  expect(
    (await live.read(async () => ({ stream: { id, sequence: 513 }, messages: [] }))).messages,
  ).toEqual([]);
});
