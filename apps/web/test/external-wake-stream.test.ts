import { expect, test } from "bun:test";
import type { WakeHint } from "@lrm/coforge-sdk/agent";
import {
  MAX_WAKE_STREAMS_PER_CREDENTIAL,
  WakeStreamLimit,
  openWakeStream,
} from "#src/server/agents/external-wake-stream.server";

const hint = (seq: number, over: Partial<WakeHint> = {}): WakeHint => ({
  target: "#general",
  channelId: "c1",
  channelType: "channel",
  pendingCount: seq,
  firstPendingMsgId: "m1",
  latestMsgId: `m${seq}`,
  latestSeq: String(seq),
  latestSenderName: "ada",
  latestSenderType: "human",
  flags: [],
  ...over,
});

type Frame = { event: string; data: unknown };

function frames(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      return {
        event: lines.find((l) => l.startsWith("event: "))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)),
      };
    });
}

function harness(initial: WakeHint[]) {
  let current = initial;
  let listener: (() => void) | undefined;
  let alive = true;
  let unsubscribed = 0;
  let released = 0;
  const stream = openWakeStream(
    {
      listHints: async () => current,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          unsubscribed++;
          listener = undefined;
        };
      },
      revalidate: async () => alive,
      release: () => {
        released++;
      },
      heartbeatMs: 20,
      debounceMs: 1,
    },
    new AbortController().signal,
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read = async () => frames(decoder.decode((await reader.read()).value));
  return {
    read,
    cancel: () => reader.cancel(),
    set: (hints: WakeHint[]) => {
      current = hints;
      listener?.();
    },
    revoke: () => {
      alive = false;
    },
    done: async () => (await reader.read()).done,
    get unsubscribed() {
      return unsubscribed;
    },
    get released() {
      return released;
    },
  };
}

test("a connection first sends the current hints", async () => {
  const h = harness([hint(2)]);
  expect(await h.read()).toEqual([{ event: "hints", data: { hints: [hint(2)] } }]);
  await h.cancel();
});

test("a conversation that gains unread sends one hint event, an unchanged one none", async () => {
  const h = harness([hint(2)]);
  await h.read();
  h.set([hint(2)]);
  h.set([hint(3)]);
  const next = await h.read();
  expect(next[0]).toEqual({ event: "hint", data: hint(3) });
  await h.cancel();
});

test("a heartbeat is sent and the stream closes once the credential is revoked", async () => {
  const h = harness([]);
  await h.read();
  expect((await h.read())[0]!.event).toBe("heartbeat");
  h.revoke();
  expect(await h.done()).toBe(true);
  expect(h.unsubscribed).toBe(1);
  expect(h.released).toBe(1);
});

test("cancelling releases the listener and the slot once", async () => {
  const h = harness([]);
  await h.read();
  await h.cancel();
  expect(h.unsubscribed).toBe(1);
  expect(h.released).toBe(1);
});

test("a credential holds at most the capped number of streams", () => {
  const limit = new WakeStreamLimit();
  const releases = Array.from({ length: MAX_WAKE_STREAMS_PER_CREDENTIAL }, () =>
    limit.acquire("c"),
  );
  expect(releases.every((release) => release !== undefined)).toBe(true);
  expect(limit.acquire("c")).toBeUndefined();
  expect(limit.acquire("other")).toBeDefined();
  releases[0]!();
  expect(limit.acquire("c")).toBeDefined();
});

async function hintQueriesAfterBeats(safetyRefreshMs: number): Promise<number> {
  let queries = 0;
  const stream = openWakeStream(
    {
      listHints: async () => {
        queries++;
        return [];
      },
      subscribe: () => () => {},
      revalidate: async () => true,
      release: () => {},
      heartbeatMs: 10,
      safetyRefreshMs,
    },
    new AbortController().signal,
  );
  const reader = stream.getReader();
  await reader.read();
  for (let beat = 0; beat < 3; beat++) await reader.read();
  await reader.cancel();
  return queries;
}

test("heartbeats without a signal do not re-query the hints", async () => {
  expect(await hintQueriesAfterBeats(60_000)).toBe(1);
});

test("a heartbeat past the safety interval re-queries the hints", async () => {
  expect(await hintQueriesAfterBeats(15)).toBeGreaterThan(1);
});

function lifecycle(over: { subscribe?: () => () => void; aborted?: boolean } = {}) {
  const counts = { unsubscribed: 0, released: 0, listed: 0 };
  const controller = new AbortController();
  if (over.aborted) controller.abort();
  const stream = openWakeStream(
    {
      listHints: async () => {
        counts.listed++;
        return [];
      },
      subscribe:
        over.subscribe ??
        (() => () => {
          counts.unsubscribed++;
        }),
      revalidate: async () => true,
      release: () => {
        counts.released++;
      },
      heartbeatMs: 5,
      debounceMs: 1,
    },
    controller.signal,
  );
  return { counts, controller, stream };
}

test("a request already aborted opens nothing and releases the slot", async () => {
  const { counts, stream } = lifecycle({ aborted: true });
  const result = await stream
    .getReader()
    .read()
    .catch(() => ({ done: true }));
  await Bun.sleep(30);
  expect(result.done).toBe(true);
  expect(counts).toEqual({ unsubscribed: 0, released: 1, listed: 0 });
});

test("a subscribe that throws releases the slot and errors the stream", async () => {
  const { counts, stream } = lifecycle({
    subscribe: () => {
      throw new Error("bus down");
    },
  });
  await expect(stream.getReader().read()).rejects.toThrow("bus down");
  await Bun.sleep(30);
  expect(counts.released).toBe(1);
});
