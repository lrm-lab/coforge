import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "../src/cli-error";

test("channel management commands parse into a channel operation and dispatch through the transport", async () => {
  expect(parseArgs(["channel", "info", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "info", target: "#engineering" },
  });
  expect(parseArgs(["channel", "members", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "members", target: "#engineering" },
  });
  expect(parseArgs(["channel", "join", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "join", target: "#engineering" },
    json: false,
  });
  expect(parseArgs(["channel", "leave", "--target", "#engineering", "--json"])).toEqual({
    command: "channel-manage",
    channel: { operation: "leave", target: "#engineering" },
    json: true,
  });
  expect(parseArgs(["channel", "create", "--name", "engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "create", name: "engineering", description: undefined },
    json: false,
  });
  expect(
    parseArgs(["channel", "create", "--name", "engineering", "--description", "Eng team"]),
  ).toEqual({
    command: "channel-manage",
    channel: { operation: "create", name: "engineering", description: "Eng team" },
    json: false,
  });
  expect(
    parseArgs(["channel", "update", "--target", "#engineering", "--description", "Eng team"]),
  ).toEqual({
    command: "channel-manage",
    channel: {
      operation: "update",
      target: "#engineering",
      name: undefined,
      description: "Eng team",
    },
    json: false,
  });
  expect(parseArgs(["channel", "lifecycle", "archive", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "archive", target: "#engineering" },
    json: false,
  });
  expect(parseArgs(["channel", "lifecycle", "unarchive", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "unarchive", target: "#engineering" },
    json: false,
  });
  expect(
    parseArgs(["channel", "add-member", "--target", "#engineering", "--user", "@alice"]),
  ).toEqual({
    command: "channel-manage",
    channel: { operation: "add-member", target: "#engineering", user: "@alice", agent: undefined },
    json: false,
  });
  expect(
    parseArgs(["channel", "remove-member", "--target", "#engineering", "--agent", "@reviewer"]),
  ).toEqual({
    command: "channel-manage",
    channel: {
      operation: "remove-member",
      target: "#engineering",
      user: undefined,
      agent: "@reviewer",
    },
    json: false,
  });

  const calls: unknown[] = [];
  const result = await run(["channel", "join", "--target", "#engineering"], {
    check: async () => {
      throw new Error("unexpected check");
    },
    read: async () => {
      throw new Error("unexpected read");
    },
    send: async () => {
      throw new Error("unexpected send");
    },
    view: async () => {
      throw new Error("unexpected view");
    },
    channel: async (command) => {
      calls.push(command);
      return {
        idempotencyKey: "r-1",
        target: "#engineering",
        joined: true,
        alreadyJoined: false,
      };
    },
  });
  expect(calls).toEqual([{ operation: "join", target: "#engineering" }]);
  expect(result).toBe(
    [
      "Joined #engineering. You can now send messages there and receive ordinary channel delivery.",
      "Still arrives:",
      "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
      "- Threads you started or follow stay followed even if you later mute this channel.",
    ].join("\n"),
  );
});

test("channel join/leave/update/lifecycle/add-member/remove-member reject a non-regular target", () => {
  for (const args of [
    ["channel", "join", "--target", "@alice"],
    ["channel", "leave", "--target", "#general:12345678"],
    ["channel", "update", "--target", "general", "--description", "x"],
    ["channel", "lifecycle", "archive", "--target", "@alice"],
    ["channel", "add-member", "--target", "@alice", "--user", "@bob"],
    ["channel", "remove-member", "--target", "thread-123", "--user", "@bob"],
  ]) {
    try {
      parseArgs(args);
      throw new Error(`expected a CliError for ${args.join(" ")}`);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("INVALID_TARGET");
      expect((error as CliError).message).toBe(
        "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      );
    }
  }
  // info/members accept a wider target grammar (thread targets, @user) and are unaffected.
  expect(parseArgs(["channel", "info", "@alice"])).toEqual({
    command: "channel-manage",
    channel: { operation: "info", target: "@alice" },
  });
  expect(parseArgs(["channel", "members", "#general:12345678"])).toEqual({
    command: "channel-manage",
    channel: { operation: "members", target: "#general:12345678" },
  });
});

test("channel management commands reject malformed arguments and require exactly one of --user/--agent", () => {
  expect(() => parseArgs(["channel", "info"])).toThrow("--target is required.");
  expect(() => parseArgs(["channel", "info", "#a", "extra"])).toThrow('Unknown argument "extra"');
  expect(() => parseArgs(["channel", "join"])).toThrow("--target is required.");
  expect(() => parseArgs(["channel", "create"])).toThrow("--name is required.");
  expect(() => parseArgs(["channel", "update", "--target", "#a"])).toThrow(
    "Provide at least one of --name, --description, --public, or --private.",
  );
  expect(() => parseArgs(["channel", "lifecycle", "delete", "--target", "#a"])).toThrow(
    "Name archive or unarchive.",
  );
  expect(() => parseArgs(["channel", "add-member", "--target", "#a"])).toThrow(
    "Give exactly one of --user and --agent.",
  );
  expect(() =>
    parseArgs(["channel", "add-member", "--target", "#a", "--user", "@x", "--agent", "@y"]),
  ).toThrow("Give exactly one of --user and --agent.");
  expect(() => parseArgs(["channel", "bogus-operation", "--target", "#a"])).toThrow(
    "is not a channel subcommand",
  );
});

test("--private makes a channel private; --public or --private changes one, never both at once", () => {
  expect(parseArgs(["channel", "create", "--name", "eng", "--private"])).toMatchObject({
    channel: { operation: "create", name: "eng", visibility: "private" },
  });
  expect(
    (parseArgs(["channel", "create", "--name", "eng"]) as { channel: object }).channel,
  ).not.toHaveProperty("visibility");
  // As Raft's: a new channel is public unless asked otherwise.
  expect(() => parseArgs(["channel", "create", "--name", "eng", "--public"])).toThrow(
    'Unknown argument "--public"',
  );
  for (const visibility of ["public", "private"] as const)
    expect(parseArgs(["channel", "update", "--target", "#eng", `--${visibility}`])).toMatchObject({
      channel: { operation: "update", target: "#eng", visibility },
    });
  expect(() =>
    parseArgs(["channel", "update", "--target", "#eng", "--public", "--private"]),
  ).toThrow("Use either --public or --private, not both.");
  expect(() => parseArgs(["channel", "update", "--target", "#eng"])).toThrow(
    "Provide at least one of --name, --description, --public, or --private.",
  );
});

test("channel management --json prints the raw response for every subcommand", async () => {
  const rawResponse = { idempotencyKey: "r-2", target: "#eng", archived: true };
  const result = await run(["channel", "lifecycle", "archive", "--target", "#eng", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    channel: async () => rawResponse,
  });
  expect(result).toBe(rawResponse);
});
