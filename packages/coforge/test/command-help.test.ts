import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import type { MessageTransport } from "../index";

const transport = {} as unknown as MessageTransport;

test("every command prints its own --help instead of the whole usage", async () => {
  const read = await run(["message", "read", "--help"], transport);
  expect(read).toContain("coforge message read");
  expect(read).toContain("--unread");
  expect(read).toContain("--limit");

  const channel = await run(["channel", "info", "--help"], transport);
  expect(channel).toContain("coforge channel info --target '#channel'");

  // The family help answers when the subcommand has no entry of its own.
  const reminder = await run(["reminder", "--help"], transport);
  expect(reminder).toContain("coforge reminder schedule|list|cancel|update|snooze");
});

test("message read takes its flags in any order", () => {
  expect(parseArgs(["message", "read", "--unread", "--target", "#general"])).toEqual({
    command: "read",
    target: "#general",
    unread: true,
  });
  expect(
    parseArgs(["message", "read", "--limit", "5", "--around", "abcd1234", "--target", "@ada"]),
  ).toEqual({ command: "read", target: "@ada", around: "abcd1234", limit: 5 });
});

test("message read explains a limit outside the server's page and an unknown flag", () => {
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--limit", "101"])).toThrow(
    "--limit must be a whole number from 1 to 100",
  );
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--bogus"])).toThrow(
    'Unknown argument "--bogus".',
  );
});

test("channel info and members accept --target as well as a positional target", () => {
  expect(parseArgs(["channel", "info", "--target", "#general"])).toEqual({
    command: "channel-manage",
    channel: { operation: "info", target: "#general" },
  });
  expect(parseArgs(["channel", "members", "#general"])).toEqual({
    command: "channel-manage",
    channel: { operation: "members", target: "#general" },
  });
});

test("channel archive and unarchive work as top-level commands", () => {
  expect(parseArgs(["channel", "archive", "--target", "#general"])).toEqual({
    command: "channel-manage",
    channel: { operation: "archive", target: "#general" },
    json: false,
  });
  expect(parseArgs(["channel", "unarchive", "--target", "#general", "--json"])).toEqual({
    command: "channel-manage",
    channel: { operation: "unarchive", target: "#general" },
    json: true,
  });
});

test("an argument error names the command's own help", () => {
  try {
    parseArgs(["message", "read", "--target", "@ada", "--bogus"]);
    throw new Error("expected a CliError");
  } catch (error) {
    const cliError = error as { code?: string; suggestedNextAction?: string };
    expect(cliError.code).toBe("INVALID_ARG");
    expect(cliError.suggestedNextAction).toBe(
      "Run `coforge message read --help` for the accepted form.",
    );
  }
});
