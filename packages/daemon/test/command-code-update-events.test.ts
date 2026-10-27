import { expect, test } from "bun:test";
import { CommandCodeTurnEvents } from "@lrm/coforge-anvil/command-code";
import { commandCodeRuntimeHost } from "#src/code-agent/command-code/host";

test("a Command Code shell call announces a reply intent from its command", () => {
  const turn = new CommandCodeTurnEvents(commandCodeRuntimeHost);
  expect(
    turn.read({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Shell: coforge message send --target @someone",
      kind: "execute",
      rawInput: { command: "coforge message send --target @someone" },
    }),
  ).toEqual([
    {
      type: "tool-start",
      id: "call-1",
      name: "shell_command",
      input: { command: "coforge message send --target @someone" },
    },
    { type: "reply-intent", id: "call-1", target: "@someone" },
  ]);
});

test("a Command Code powershell call announces a reply intent, and a non-shell tool does not", () => {
  const shell = new CommandCodeTurnEvents(commandCodeRuntimeHost);
  expect(
    shell
      .read({
        sessionUpdate: "tool_call",
        toolCallId: "ps-1",
        title: "powershell",
        rawInput: { command: "coforge message send --target #general" },
      })
      .some((event) => event.type === "reply-intent"),
  ).toBe(true);

  const read = new CommandCodeTurnEvents(commandCodeRuntimeHost);
  expect(
    read.read({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read: notes.md",
      kind: "read",
      rawInput: { file_path: "notes.md", command: "coforge message send --target @someone" },
    }),
  ).toEqual([
    {
      type: "tool-start",
      id: "read-1",
      name: "read_file",
      input: { file_path: "notes.md", command: "coforge message send --target @someone" },
    },
  ]);
});

test("a Command Code display title does not become the activity name", () => {
  const turn = new CommandCodeTurnEvents(commandCodeRuntimeHost);
  expect(
    turn.read({
      sessionUpdate: "tool_call",
      toolCallId: "fetch-1",
      title: "Fetch: https://example.com/secret",
      kind: "fetch",
      rawInput: { url: "https://example.com/secret" },
    }),
  ).toEqual([
    {
      type: "tool-start",
      id: "fetch-1",
      name: "web_fetch",
      input: { url: "https://example.com/secret" },
    },
  ]);
  expect(
    turn.read({
      sessionUpdate: "tool_call",
      toolCallId: "agent-1",
      title: "Agent: read /etc/passwd",
      kind: "other",
      rawInput: { description: "read /etc/passwd" },
    }),
  ).toEqual([
    {
      type: "tool-start",
      id: "agent-1",
      name: "Agent",
      input: { description: "read /etc/passwd" },
    },
  ]);
});
