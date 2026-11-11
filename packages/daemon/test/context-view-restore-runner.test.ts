import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  encodeContextViewRestoreChildResult,
  decodeContextViewRestoreChildResult,
  firstStderrLine,
  runContextViewRestoreInChild,
  selfSubcommand,
} from "#src/agent-context-view/context-view-restore-runner";

test("a compiled Computer runs the subcommand as its first argument", () => {
  // Measured in a compiled binary: execPath is the binary and argv[1] is `/$bunfs/root/...`, while
  // the Computer itself was started with a subcommand — so argv[1] is never this subcommand
  // (task #739).
  expect(
    selfSubcommand("__restore-context-view", {
      execPath: "/Applications/CoForge/coforge-computer",
      script: "/$bunfs/root/probe",
    }),
  ).toEqual(["/Applications/CoForge/coforge-computer", "__restore-context-view"]);
});

test("under bun the script comes before the subcommand", () => {
  expect(
    selfSubcommand("__restore-context-view", {
      execPath: "/usr/local/bin/bun",
      script: "/repo/packages/computer/src/main.ts",
    }),
  ).toEqual([
    "/usr/local/bin/bun",
    "/repo/packages/computer/src/main.ts",
    "__restore-context-view",
  ]);
});

test("the script path decides the shape, not the executable's name", () => {
  // The two shapes are told apart by where the entrypoint is, so a name says nothing: a compiled
  // binary may be named like bun, and bun itself may be renamed or reached through a shim.
  expect(
    selfSubcommand("__restore-context-view", {
      execPath: "/Applications/CoForge/bun-computer-copy",
      script: "/$bunfs/root/probe",
    }),
  ).toEqual(["/Applications/CoForge/bun-computer-copy", "__restore-context-view"]);
  expect(
    selfSubcommand("__restore-context-view", {
      execPath: "/Users/dev/.local/share/mise/shims/coforge-computer-runner",
      script: "/repo/packages/computer/src/main.ts",
    }),
  ).toEqual([
    "/Users/dev/.local/share/mise/shims/coforge-computer-runner",
    "/repo/packages/computer/src/main.ts",
    "__restore-context-view",
  ]);
  // No script at all: the executable is the only thing there is to run.
  expect(selfSubcommand("__restore-context-view", { execPath: "/usr/local/bin/bun" })).toEqual([
    "/usr/local/bin/bun",
    "__restore-context-view",
  ]);
});

test("a child that never starts leaves its first stderr line on the refusal", async () => {
  const result = await runContextViewRestoreInChild(
    {
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: Buffer.from("", "utf8"),
      offset: 0,
    },
    { command: ["sh", "-c", "echo 'error: unknown command' >&2; exit 2"] },
  );
  expect(result).toEqual({
    ok: false,
    failure: "read_failed",
    detail: "error: unknown command",
  });
});

test("a child silent on stderr keeps the refusal as it was", () => {
  expect(firstStderrLine("")).toBeUndefined();
  expect(firstStderrLine("\n\n")).toBeUndefined();
  expect(firstStderrLine("first\nsecond")).toBe("first");
  expect(firstStderrLine(`${"x".repeat(400)}\nrest`)).toHaveLength(301);
});

test("round trips bounded child result framing", () => {
  const result = {
    ok: true as const,
    view: {
      runtime: "codex" as const,
      sessionId: "s1",
      messageId: "m1",
      messages: [],
      source: { kind: "native" as const, format: "codex-rollout" },
      redactions: { media: 0, diagnostic: 0 },
    },
  };
  expect(decodeContextViewRestoreChildResult(encodeContextViewRestoreChildResult(result))).toEqual(
    result,
  );
});

test("preserves the Raft too-large cause in child framing", () => {
  const result = {
    ok: false as const,
    failure: "too_large" as const,
    tooLargeCause: "restore_limit" as const,
  };
  expect(decodeContextViewRestoreChildResult(encodeContextViewRestoreChildResult(result))).toEqual(
    result,
  );
});

test("runs the real restore mode in a Bun child", async () => {
  const buffer = Buffer.from(
    [
      { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
      { type: "user_message", session_id: "s1", message: "hello" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    "utf8",
  );
  const result = await runContextViewRestoreInChild(
    { runtime: "codex", sessionId: "s1", messageId: "m1", buffer, offset: buffer.length },
    {
      command: [
        process.execPath,
        join(import.meta.dir, "../../../packages/computer/src/main.ts"),
        "__restore-context-view",
      ],
    },
  );
  expect(result.ok).toBe(true);
});

test("maps a restore timeout to a bounded refusal", async () => {
  const result = await runContextViewRestoreInChild(
    {
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: Buffer.from("", "utf8"),
      offset: 0,
    },
    { command: ["sh", "-c", "sleep 1"], timeoutMs: 10 },
  );
  expect(result).toEqual({ ok: false, failure: "read_failed" });
});

test("rejects oversized child headers and payloads", () => {
  const header = `${"x".repeat(64 * 1024 + 1)}\n{}`;
  expect(decodeContextViewRestoreChildResult(header)).toEqual({
    ok: false,
    failure: "read_failed",
  });
});
