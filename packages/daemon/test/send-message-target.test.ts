import { expect, test } from "bun:test";
import {
  isShellToolName,
  sendCommandTarget,
  sendMessageTarget,
} from "#src/code-agent/send-command-target";
import { resolveCoforgeInvocation } from "#src/code-agent/tool-activity";

test("a message send names its target for the reply intent, and only a send that can post does", () => {
  const targetOf = (command: string, extra = {}) =>
    sendMessageTarget({
      type: "tool-start",
      id: "call-1",
      name: "bash",
      input: { command },
      ...extra,
    });
  expect(targetOf("coforge message send --target '#general:ab12cd34' <<'EOF'\nhi\nEOF")).toBe(
    "#general:ab12cd34",
  );
  expect(targetOf("coforge message send --send-draft --target @bob")).toBe("@bob");
  expect(targetOf("cd /work && coforge message send --target=@bob")).toBe("@bob");
  // Help, another subcommand, an ordinary command and a send with no target post nothing.
  expect(targetOf("coforge message send --help")).toBeUndefined();
  expect(targetOf("coforge message send -h")).toBeUndefined();
  expect(targetOf("coforge message check")).toBeUndefined();
  expect(targetOf("coforge message read --target @bob")).toBeUndefined();
  expect(targetOf("coforge message send")).toBeUndefined();
  expect(targetOf("ls -la")).toBeUndefined();
  // A subagent's call is not the Agent's reply.
  expect(
    targetOf("coforge message send --target @bob", {
      subagent: { parentToolUseId: "parent-1" },
    }),
  ).toBeUndefined();
  expect(
    sendMessageTarget({ type: "tool-start", id: "call-2", name: "Read", input: { path: "a" } }),
  ).toBeUndefined();
});

test("a command still being written names its target only once the target token is closed", () => {
  const partial = (command: string) => sendCommandTarget(command, "partial");
  expect(partial("coforge message send --target #general ")).toBe("#general");
  expect(partial("coforge message send --target '#general:ab12cd34' --content")).toBe(
    "#general:ab12cd34",
  );
  expect(partial("coforge message send --target=@bob\n")).toBe("@bob");
  expect(partial("cd /work && coforge message send --target @bob <<'EOF'")).toBe("@bob");
  expect(partial("coforge message send --content hi --target @bob;")).toBe("@bob");
  // The tail may still grow, whatever it looks like: a bare token, an open or just-closed quote.
  expect(partial("coforge message send --target #gen")).toBeUndefined();
  expect(partial("coforge message send --target=@bo")).toBeUndefined();
  expect(partial("coforge message send --target '#general")).toBeUndefined();
  expect(partial("coforge message send --target '#general'")).toBeUndefined();
  expect(partial('coforge message send --target "#general"')).toBeUndefined();
  expect(partial("coforge message send --target #general\\")).toBeUndefined();
  expect(partial("coforge message send --target")).toBeUndefined();
  // A backslash-escaped space does not end a token.
  expect(partial("coforge message send --target #gen\\ eral")).toBeUndefined();
  // Not a send, or one that posts nothing.
  expect(partial("coforge message send --help ")).toBeUndefined();
  expect(partial("coforge message read --target @bob ")).toBeUndefined();
  expect(partial("ls -la ")).toBeUndefined();
  // A finished command reads as the whole thing, with no tail to wait for.
  expect(sendCommandTarget("coforge message send --target #general", "complete")).toBe("#general");
});

test("the target is the raw --target of the invocation, not the activity row's copy", () => {
  const target = (command: string) => sendCommandTarget(command, "complete");
  // The last --target wins, as the CLI parser keeps it.
  expect(target("coforge message send --target @bob --target @eve")).toBe("@eve");
  // The row collapses whitespace and cuts at 200 code points; the target is neither.
  expect(target(`coforge message send --target "#gen  eral"`)).toBe("#gen  eral");
  expect(target(`coforge message send --target ${"#" + "a".repeat(200)}`)).toBeUndefined();
  expect(target(`coforge message send --target ${"#" + "a".repeat(199)}`)).toBe(
    "#" + "a".repeat(199),
  );
  // --help anywhere after the subcommand posts nothing, wherever it sits.
  expect(target("coforge message send --target @bob --help")).toBeUndefined();
  expect(target("coforge message send --help --target @bob")).toBeUndefined();
  expect(target("coforge message send --target=")).toBeUndefined();
});

test("a tool name is a shell tool when it resolves to the shell", () => {
  for (const name of ["bash", "Bash", "shell", "command_execution", "run_shell_command"])
    expect(isShellToolName(name)).toBe(true);
  for (const name of ["Read", "write_file", "mcp__chat__bash", "", "apply_patch"])
    expect(isShellToolName(name)).toBe(false);
});

test("a CoForge invocation exposes the arguments after its subcommand as the shell passed them", () => {
  expect(
    resolveCoforgeInvocation(`cd /work && coforge message send --target "#gen  eral" -h`),
  ).toEqual({
    tool: "send_message",
    summary: "#gen  eral",
    args: ["--target", "#gen  eral", "-h"],
  });
  expect(resolveCoforgeInvocation("ls -la")).toBeNull();
});

test("a command being written reads only the tokens it has closed", () => {
  const partial = (command: string) => resolveCoforgeInvocation(command, true)?.args;
  expect(partial("coforge message send --target @bob ")).toEqual(["--target", "@bob"]);
  expect(partial("coforge message send --target @bo")).toEqual(["--target"]);
  expect(partial("coforge message send --target '@bob'")).toEqual(["--target"]);
  expect(partial("coforge message send --target '@b")).toEqual(["--target"]);
  // A newline or heredoc closes the token before it.
  expect(partial("coforge message send --target @bob\nmore")).toEqual(["--target", "@bob"]);
  expect(partial("coforge message send --target @bob<<EOF")).toEqual(["--target", "@bob"]);
  // Whole commands read the same in either mode once finished with a boundary.
  expect(resolveCoforgeInvocation("coforge message send --target @bob")?.args).toEqual([
    "--target",
    "@bob",
  ]);
});
