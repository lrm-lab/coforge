import { expect, test } from "bun:test";
import { parseArgs, run, type MessageTransport } from "../index";

test("message read --unread reads from the read position and takes no history anchor", () => {
  expect(parseArgs(["message", "read", "--target", "@ada", "--unread"])).toEqual({
    command: "read",
    target: "@ada",
    unread: true,
  });
  expect(parseArgs(["message", "read", "--target", "@ada", "--limit", "5", "--unread"])).toEqual({
    command: "read",
    target: "@ada",
    limit: 5,
    unread: true,
  });
  for (const anchor of ["--before", "--after", "--around"])
    expect(() =>
      parseArgs(["message", "read", "--target", "@ada", "--unread", anchor, "abcd1234"]),
    ).toThrow("--unread reads forward from your read position");
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--unread", "--unread"])).toThrow(
    '"--unread" is given more than once',
  );
});

test("message read without --unread keeps its one-anchor window", () => {
  expect(parseArgs(["message", "read", "--target", "@ada", "--around", "abcd1234"])).toEqual({
    command: "read",
    target: "@ada",
    around: "abcd1234",
  });
  expect(() =>
    parseArgs(["message", "read", "--target", "@ada", "--before", "a", "--after", "b"]),
  ).toThrow("Give at most one of --before, --after and --around.");
});

test("message read --unread asks the transport for unread and prints the unread window", async () => {
  const calls: unknown[] = [];
  const transport = {
    read: async (target: string, options: unknown) => {
      calls.push([target, options]);
      return { messages: [], unreadCursorBefore: 4, readPositionAfter: 4 };
    },
  } as unknown as MessageTransport;
  const output = await run(["message", "read", "--target", "@ada", "--unread"], transport);
  expect(calls).toEqual([["@ada", { command: "read", target: "@ada", unread: true }]]);
  expect(output).toEndWith("No unread messages in @ada. You have read through seq 4.");
});

test("the re-read command an unread read prints parses and asks the transport for the same position", async () => {
  const reads: unknown[] = [];
  const transport = {
    read: async (target: string, options: unknown) => {
      reads.push([target, options]);
      return reads.length === 1
        ? {
            messages: [
              {
                id: "aaaaaaaa-0000-4000-8000-000000000007",
                sequence: 7,
                senderKind: "human",
                senderHandle: "ada",
                senderDescription: "",
                target: "@ada",
                body: "hi",
                createdAt: "2026-09-07T10:00:00Z",
                attachments: [],
              },
            ],
            unreadCursorBefore: 4,
            readPositionAfter: 7,
          }
        : { messages: [] };
    },
  } as unknown as MessageTransport;
  const unread = String(await run(["message", "read", "--target", "@ada", "--unread"], transport));
  const hint = unread.split("\n").find((line) => line.includes("To re-read these:"));
  const command = hint?.split("To re-read these: ")[1];
  expect(command).toBeDefined();
  // Run the printed command word for word, as an Agent would.
  const argv = [...command!.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
  expect(argv[0]).toBe("coforge");
  await run(argv.slice(1), transport);
  expect(reads[1]).toEqual(["@ada", { command: "read", target: "@ada", after: "4" }]);
});
