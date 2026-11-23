import { describe, expect, test } from "bun:test";

import {
  createComposerOutbox,
  type OutboxStorage,
  type OutgoingMessage,
} from "#src/features/conversations/composer-outbox";

function memoryStorage(): OutboxStorage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let counter = 0;
function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  counter += 1;
  return {
    localId: `ack-local-${counter}`,
    draftKey: "chat-a",
    body: `message ${counter}`,
    idempotencyKey: `ack-request-${counter}`,
    asTask: false,
    attachments: [],
    pins: [],
    ...overrides,
  };
}

type SentPayload = {
  id: string;
  sequence: number;
  unresolvedMentionHandles?: string[];
  pendingMentionActions?: Array<{ handle: string; kind: "invite" }>;
};

describe("composer outbox delivery ack release", () => {
  test("acknowledging the in-flight head releases the next queued send while preserving late HTTP mention feedback once", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const first = message({ body: "first @ghost" });
    const second = message({ body: "second" });
    const firstStarted = gate();
    let resolveFirstHttp!: (value: SentPayload) => void;
    const calls: string[] = [];
    const onSentPayloads: SentPayload[] = [];
    let firstDeliveredIdCalls = 0;

    const firstDone = outbox
      .send(
        first,
        () => {
          calls.push("first");
          firstStarted.open();
          return new Promise<SentPayload>((resolve) => {
            resolveFirstHttp = resolve;
          });
        },
        (sent) => {
          firstDeliveredIdCalls += 1;
          return sent.id;
        },
      )
      .then((value) => {
        if (value) onSentPayloads.push(value);
        return value;
      });

    const secondDone = outbox.send(
      second,
      async () => {
        calls.push("second");
        return { id: "message-2", sequence: 2 };
      },
      (sent) => sent.id,
    );

    await firstStarted.promise;
    expect(calls).toEqual(["first"]);

    outbox.acknowledge(first.idempotencyKey, "message-1");
    expect(await secondDone).toEqual({ id: "message-2", sequence: 2 });
    expect(calls).toEqual(["first", "second"]);
    expect(onSentPayloads).toEqual([]);
    expect(outbox.entries("chat-a")).toEqual([
      { ...first, state: "delivered", messageId: "message-1" },
      { ...second, state: "delivered", messageId: "message-2" },
    ]);

    outbox.discard(first.localId);
    expect(outbox.entries("chat-a")).toEqual([
      { ...second, state: "delivered", messageId: "message-2" },
    ]);

    const lateResult: SentPayload = {
      id: "message-1",
      sequence: 1,
      unresolvedMentionHandles: ["ghost"],
      pendingMentionActions: [{ handle: "ghost", kind: "invite" }],
    };
    resolveFirstHttp(lateResult);
    expect(await firstDone).toEqual(lateResult);
    await Promise.resolve();
    expect(calls).toEqual(["first", "second"]);
    expect(firstDeliveredIdCalls).toBe(0);
    expect(onSentPayloads).toEqual([lateResult]);
    expect(outbox.entries("chat-a")).toEqual([
      { ...second, state: "delivered", messageId: "message-2" },
    ]);
  });

  test("a late HTTP failure after acknowledgment does not revert to unsent, re-enqueue, or call onSent", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const first = message({ body: "first" });
    const second = message({ body: "second" });
    const firstStarted = gate();
    let rejectFirstHttp!: (cause: unknown) => void;
    const calls: string[] = [];
    const onSentPayloads: SentPayload[] = [];

    const firstDone = outbox
      .send(first, () => {
        calls.push("first");
        firstStarted.open();
        return new Promise<SentPayload>((_, reject) => {
          rejectFirstHttp = reject;
        });
      })
      .then((value) => {
        if (value) onSentPayloads.push(value);
        return value;
      });

    const secondDone = outbox.send(
      second,
      async () => {
        calls.push("second");
        return { id: "message-2", sequence: 2 };
      },
      (sent) => sent.id,
    );

    await firstStarted.promise;
    outbox.acknowledge(first.idempotencyKey, "message-1");
    expect(await secondDone).toEqual({ id: "message-2", sequence: 2 });
    expect(calls).toEqual(["first", "second"]);

    outbox.discard(first.localId);
    expect(outbox.entries("chat-a")).toEqual([
      { ...second, state: "delivered", messageId: "message-2" },
    ]);

    rejectFirstHttp(new TypeError("Failed to fetch"));
    expect(await firstDone).toBeUndefined();
    await Promise.resolve();
    expect(calls).toEqual(["first", "second"]);
    expect(onSentPayloads).toEqual([]);
    expect(outbox.entries("chat-a")).toEqual([
      { ...second, state: "delivered", messageId: "message-2" },
    ]);
  });

  test("wrong keys and other conversations do not release a chat's queued send", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const chatAFirst = message({ draftKey: "chat-a", body: "a1" });
    const chatASecond = message({ draftKey: "chat-a", body: "a2" });
    const chatBFirst = message({ draftKey: "chat-b", body: "b1" });
    const aFirstStarted = gate();
    const aFirstHttp = gate();
    const bFirstStarted = gate();
    const calls: string[] = [];

    const aFirstDone = outbox.send(chatAFirst, async () => {
      calls.push("a1");
      aFirstStarted.open();
      await aFirstHttp.promise;
    });
    const aSecondDone = outbox.send(chatASecond, async () => {
      calls.push("a2");
    });
    void outbox.send(chatBFirst, () => {
      calls.push("b1");
      bFirstStarted.open();
      return new Promise<never>(() => {});
    });

    await Promise.all([aFirstStarted.promise, bFirstStarted.promise]);
    outbox.acknowledge("wrong-idempotency-key", "msg-wrong");
    outbox.acknowledge(chatBFirst.idempotencyKey, "msg-b1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["a1", "b1"]);
    aFirstHttp.open();
    await Promise.all([aFirstDone, aSecondDone]);
    expect(calls).toEqual(["a1", "b1", "a2"]);
  });

  test("an already-acknowledged queued send is skipped instead of posted again", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const first = message({ body: "first" });
    const second = message({ body: "second" });
    const firstHttp = gate();
    const calls: string[] = [];

    const firstDone = outbox.send(first, async () => {
      calls.push("first");
      await firstHttp.promise;
    });
    const secondDone = outbox.send(second, async () => {
      calls.push("second");
    });

    outbox.acknowledge(second.idempotencyKey, "message-2");
    firstHttp.open();
    await Promise.all([firstDone, secondDone]);
    expect(calls).toEqual(["first"]);
    expect(outbox.entries("chat-a")).toEqual([
      { ...second, state: "delivered", messageId: "message-2" },
    ]);
  });
});
