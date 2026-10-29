import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

const list = (over = {}) => ({
  ok: true as const,
  view: "unread" as const,
  items: [],
  totals: { conversations: 0, dms: 0, mentions: 0 },
  hasMore: false,
  nextBefore: null,
  ...over,
});

const base = {
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
};

test("inbox check parses view, before and json", () => {
  expect(parseArgs(["inbox", "check"])).toEqual({ command: "inbox-check" });
  expect(parseArgs(["inbox", "check", "--json"])).toEqual({ command: "inbox-check", json: true });
  expect(parseArgs(["inbox", "check", "--view", "mentions", "--before", "42"])).toEqual({
    command: "inbox-check",
    view: "mentions",
    before: 42,
  });
  expect(() => parseArgs(["inbox", "ack", "--item", "reminder:id:1"])).toThrow(
    "is not a command this CLI knows",
  );
  expect(() => parseArgs(["inbox", "check", "--bogus"])).toThrow("Usage:");
  expect(() => parseArgs(["inbox", "check", "--view", "all"])).toThrow(
    "--view must be one of unread, mentions; got all",
  );
  expect(() => parseArgs(["inbox", "check", "--before", "0"])).toThrow(
    "--before must be a positive integer cursor (the value printed on the More: line); got 0",
  );
});

test("inbox check reads the server list and the daemon together", async () => {
  const requests: unknown[] = [];
  const output = await run(["inbox", "check", "--view", "mentions", "--before", "9"], {
    ...base,
    inboxList: async (request) => {
      requests.push(request);
      return list({ view: "mentions" });
    },
    inboxCheck: async () => ({ entries: [] }),
  });
  expect(requests).toEqual([{ view: "mentions", before: 9 }]);
  expect(output).toContain("Inbox: nothing unread.");
});

test("a daemon failure is reported beside the list; a list failure fails", async () => {
  const output = await run(["inbox", "check"], {
    ...base,
    inboxList: async () => list(),
    inboxCheck: async () => {
      throw new Error("down");
    },
  });
  expect(output).toContain("Daemon pending buffer unavailable (down)");
  await expect(
    run(["inbox", "check"], {
      ...base,
      inboxList: async () => {
        throw new Error("server");
      },
      inboxCheck: async () => ({ entries: [] }),
    }),
  ).rejects.toThrow("server");
});

test("inbox JSON has the new shape and hides message ordering fields", async () => {
  const output = await run(["inbox", "check", "--json"], {
    ...base,
    inboxList: async () => list(),
    inboxCheck: async () => ({
      entries: [
        {
          kind: "message_target",
          messageTarget: {
            target: "@ada",
            pendingCount: 2,
            firstPendingSequence: 7,
            flags: ["dm"],
          },
        },
      ],
    }),
  });
  const parsed = JSON.parse(output as string);
  expect(parsed.view).toBe("unread");
  expect(parsed.pendingRows).toEqual([{ target: "@ada", pendingCount: 2, flags: ["dm"] }]);
  expect(output).not.toContain("firstPendingSequence");
});
