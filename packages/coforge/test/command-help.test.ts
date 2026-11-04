import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import type { MessageTransport } from "../index";
import { CLI_USAGE } from "../src/usage";
import { commandHelp } from "../src/command-help";
import { parseAppArgs } from "../src/app-commands";

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

test("every command the top-level usage lists has its own help entry", async () => {
  const missing: string[] = [];
  for (const match of CLI_USAGE.matchAll(/coforge ([a-z-]+ )?([a-z-]+(?:\|[a-z-]+)*)/g)) {
    const prefix = match[1]?.trim();
    for (const alternative of match[2]!.split("|")) {
      const path = prefix ? `${prefix} ${alternative}` : alternative;
      if (commandHelp(path.split(" ")) === undefined) missing.push(path);
    }
  }
  expect(missing).toEqual([]);
});

test("task create --help explains atomic assignment and how to undo an accidental self-start", () => {
  const help = commandHelp(["task", "create", "--help"])!;
  expect(help).toContain("Atomic assignment:");
  expect(help).toContain("Self-assignment starts work");
  expect(help).toContain(
    "coforge task update --target <channel> --number <N> --status todo`; the task stays assigned to you.",
  );
  expect(help).toContain(
    "If handle resolution or channel authorization fails, no task is created.",
  );
  // Guidance sits between the form and the example.
  expect(help.indexOf("Atomic assignment:")).toBeLessThan(help.indexOf("Example:"));
});

test("coforge --help lists the top-level commands, and a group --help lists its commands", async () => {
  const top = await run(["--help"], transport);
  expect(top).toContain("Commands:");
  expect(top).toContain("  message");
  expect(top).toContain("  task");
  expect(top).toContain("  app");
  expect(top).toContain("  whoami");

  const task = await run(["task", "--help"], transport);
  expect(task).toContain("coforge task");
  expect(task).toContain("Commands:");
  expect(task).toContain("  view");
  expect(task).toContain("  claim");

  const app = commandHelp(["app"]);
  expect(app).toContain("  update");
  expect(app).toContain("  marketplace");
});

test("an unknown command names the deepest level's commands and suggests near misses", async () => {
  const nested = (await run(["message", "bogus"], transport).catch((e: unknown) => e)) as {
    code?: string;
    message?: string;
    suggestedNextAction?: string;
  };
  expect(nested.code).toBe("INVALID_ARG");
  expect(nested.message).toContain("not a command this CLI knows");
  expect(nested.suggestedNextAction).toContain("coforge message --help");
  expect(nested.suggestedNextAction).toContain("check");

  const typo = (await run(["projet", "list"], transport).catch((e: unknown) => e)) as {
    code?: string;
    message?: string;
    suggestedNextAction?: string;
  };
  expect(typo.suggestedNextAction).toContain("Did you mean `coforge workspace info --projects`?");

  const alias = (await run(["project", "list"], transport).catch((e: unknown) => e)) as {
    code?: string;
    message?: string;
    suggestedNextAction?: string;
  };
  expect(alias.suggestedNextAction).toContain("Did you mean `coforge workspace info --projects`?");

  const close = (await run(["message", "chek"], transport).catch((e: unknown) => e)) as {
    code?: string;
    message?: string;
    suggestedNextAction?: string;
  };
  expect(close.suggestedNextAction).toContain("Did you mean `coforge message check`?");
});

test("an unknown subcommand in a self-parsing group names that group's commands", async () => {
  type Shape = { code?: string; message?: string; suggestedNextAction?: string };

  for (const [args, group] of [
    [["task", "bogus"], "task"],
    [["reminder", "bogus"], "reminder"],
    [["mention", "bogus"], "mention"],
    [["weekly-report", "bogus"], "weekly-report"],
  ] as const) {
    const error = (await run([...args], transport).catch((e: unknown) => e)) as Shape;
    expect(error.code).toBe("INVALID_ARG");
    expect(error.suggestedNextAction).toContain(`coforge ${group} --help`);
  }

  const appError = (() => {
    try {
      parseAppArgs(["bogus"]);
    } catch (error) {
      return error as Shape;
    }
    throw new Error("expected parseAppArgs to reject");
  })();
  expect(appError.suggestedNextAction).toContain("coforge app --help");
  expect(appError.suggestedNextAction).toContain("update");

  const taskTypo = (await run(["task", "veiw"], transport).catch((e: unknown) => e)) as Shape;
  expect(taskTypo.suggestedNextAction).toContain("Did you mean `coforge task view`?");
});
