import { expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeCodeProvider, type ClaudeRuntimeHost } from "@lrm/coforge-anvil/claude-code";
import {
  CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS,
  CodexProvider,
  type CodexDirectoryEntry,
  type CodexHistoryHost,
} from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

const THREAD = "11111111-2222-4333-8444-555555555555";

type Node = { kind: "dir" } | { kind: "file"; text: string } | { kind: "link" };

function rolloutHost(options: {
  files?: Record<string, string>;
  links?: readonly string[];
  env?: Record<string, string | undefined>;
  home?: string;
  tail?: { text: string; startOffset: number };
}): CodexHistoryHost {
  const nodes = new Map<string, Node>();
  const ensureDir = (path: string) => {
    if (path === "/" || nodes.has(path)) return;
    nodes.set(path, { kind: "dir" });
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    ensureDir(parent);
  };
  for (const [path, text] of Object.entries(options.files ?? {})) {
    ensureDir(path.slice(0, path.lastIndexOf("/")) || "/");
    nodes.set(path, { kind: "file", text });
  }
  for (const path of options.links ?? []) {
    ensureDir(path.slice(0, path.lastIndexOf("/")) || "/");
    nodes.set(path, { kind: "link" });
  }
  return {
    readHostEnvironment: (name) => options.env?.[name],
    homeDirectory: () => options.home ?? "/home/fixture",
    async readDirectoryEntries(path) {
      const dir = nodes.get(path);
      if (!dir || dir.kind !== "dir") throw new Error(`not a directory: ${path}`);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of nodes.keys()) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [...names].map((name): CodexDirectoryEntry => {
        const child = nodes.get(prefix + name);
        return {
          name,
          isDirectory: () => child?.kind === "dir",
          isFile: () => child?.kind === "file",
          isSymbolicLink: () => child?.kind === "link",
        };
      });
    },
    async readFileTail(path) {
      if (options.tail) return options.tail;
      const node = nodes.get(path);
      if (!node || node.kind !== "file") throw new Error(`not a file: ${path}`);
      return { text: node.text, startOffset: 0 };
    },
  };
}

function rolloutPath(home: string, stamp: string, thread = THREAD, extra = ""): string {
  const name = `rollout-${stamp}-${thread}${extra}.jsonl`;
  return join(home, "sessions", "2026", "10", "28", name);
}

function usageCount(
  timestamp: string,
  last: { input_tokens: number; total_tokens: number },
  total: { input_tokens: number; total_tokens: number },
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { ...total, output_tokens: 0 },
        last_token_usage: { ...last, output_tokens: 0 },
      },
    },
  });
}

function tokenCount(timestamp: string, input: number | undefined): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload:
      input === undefined
        ? { type: "token_count", rate_limits: { primary: { used_percent: 1 } } }
        : {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 },
              last_token_usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 },
              model_context_window: 475_000,
            },
          },
  });
}

function message(timestamp: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function call(
  timestamp: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  output?: string,
): string[] {
  const lines = [
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: id },
    }),
  ];
  if (output !== undefined)
    lines.push(
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "function_call_output", call_id: id, output },
      }),
    );
  return lines;
}

function shell(
  timestamp: string,
  id: string,
  command: string[],
  output?: string,
  directory?: string,
): string[] {
  const lines = [
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "local_shell_call",
        call_id: id,
        status: "completed",
        action: {
          type: "exec",
          command,
          ...(directory ? { working_directory: directory } : {}),
        },
      },
    }),
  ];
  if (output !== undefined)
    lines.push(
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "function_call_output", call_id: id, output },
      }),
    );
  return lines;
}

test("Codex declares a 30 minute cold gap and Claude keeps 60", () => {
  expect(CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS).toBe(30 * 60_000);
  const codex = new CodexProvider({ host: fixtureCodexHost });
  expect(codex.idleRecycleMinColdGapMs).toBe(30 * 60_000);
  expect(codex.readSessionResumeFacts).toBeFunction();
  expect(codex.readRecycleBriefing).toBeFunction();
  const claude = new ClaudeCodeProvider({ host: {} as ClaudeRuntimeHost });
  expect(claude.idleRecycleMinColdGapMs).toBe(60 * 60_000);
});

test("facts come from the last record and the last token_count that has input tokens", async () => {
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const text = [
    tokenCount("2026-10-28T01:00:00.000Z", 10_000),
    message("2026-10-28T01:40:00.000Z", "user", "still here"),
    tokenCount("2026-10-28T01:41:00.000Z", undefined),
    "{not json",
    "",
  ].join("\n");
  const provider = new CodexProvider({
    host: { ...fixtureCodexHost, ...rolloutHost({ files: { [path]: text } }) },
  });
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/codex-home" },
    }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T01:41:00.000Z"),
    lastContextTokens: 10_000,
  });
});

test("an Agent CODEX_HOME wins, and the newest rollout of the thread is the one read", async () => {
  const older = rolloutPath("/agent-home", "2026-10-28T01-00-00");
  const newer = rolloutPath("/agent-home", "2026-10-28T03-00-00", THREAD, "_rollout1");
  const decoy = rolloutPath("/host-home", "2026-10-28T04-00-00");
  const host = rolloutHost({
    env: { CODEX_HOME: "/host-home" },
    files: {
      [older]: tokenCount("2026-10-28T01:00:00.000Z", 1),
      [newer]: tokenCount("2026-10-28T03:00:00.000Z", 180_000),
      [decoy]: tokenCount("2026-10-28T04:00:00.000Z", 9),
    },
  });
  const provider = new CodexProvider({ host: { ...fixtureCodexHost, ...host } });
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/agent-home" },
    }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T03:00:00.000Z"),
    lastContextTokens: 180_000,
  });
  expect(await provider.readSessionResumeFacts?.({ sessionId: THREAD })).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T04:00:00.000Z"),
    lastContextTokens: 9,
  });
});

test("a missing rollout, a relative CODEX_HOME, a symlink and a bad session id resume", async () => {
  const real = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const link = rolloutPath("/codex-home", "2026-10-28T02-00-00");
  const host = rolloutHost({
    files: { [real]: tokenCount("2026-10-28T01:00:00.000Z", 180_000) },
    links: [link],
  });
  const provider = new CodexProvider({ host: { ...fixtureCodexHost, ...host } });
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/missing" },
    }),
  ).toBeUndefined();
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "relative/codex" },
    }),
  ).toBeUndefined();
  expect(await provider.readSessionResumeFacts?.({ sessionId: "../" + THREAD })).toBeUndefined();
  expect(await provider.readSessionResumeFacts?.({ sessionId: "" })).toBeUndefined();
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/codex-home" },
    }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T01:00:00.000Z"),
    lastContextTokens: 180_000,
  });

  const home = "/home/fixture";
  const fallback = rolloutPath(join(home, ".codex"), "2026-10-28T01-00-00");
  const fallbackProvider = new CodexProvider({
    host: {
      ...fixtureCodexHost,
      ...rolloutHost({
        home,
        files: { [fallback]: tokenCount("2026-10-28T01:10:00.000Z", 42_000) },
      }),
    },
  });
  expect(await fallbackProvider.readSessionResumeFacts?.({ sessionId: THREAD })).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T01:10:00.000Z"),
    lastContextTokens: 42_000,
  });
});

test("a tail cut on the first line is ignored, and a directory is not a rollout", async () => {
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const good = tokenCount("2026-10-28T02:00:00.000Z", 180_000);
  const host = rolloutHost({
    files: { [path]: "placeholder" },
    tail: { text: "cut-off{\n" + good + "\n", startOffset: 4 },
  });
  const provider = new CodexProvider({ host: { ...fixtureCodexHost, ...host } });
  expect(
    await provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/codex-home" },
    }),
  ).toEqual({
    lastActivityAtMs: Date.parse("2026-10-28T02:00:00.000Z"),
    lastContextTokens: 180_000,
  });

  const directory = rolloutPath("/only-dir", "2026-10-28T01-00-00");
  const nested = join(directory, "not-a-rollout.txt");
  const dirHost = rolloutHost({ files: { [nested]: tokenCount("2026-10-28T01:00:00.000Z", 1) } });
  const dirProvider = new CodexProvider({ host: { ...fixtureCodexHost, ...dirHost } });
  expect(
    await dirProvider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/only-dir" },
    }),
  ).toBeUndefined();
});

test("the briefing keeps recent messages and actions inside the budget and withholds secret output", async () => {
  const lines = [
    message("2026-10-28T01:00:00.000Z", "user", "A".repeat(12_000)),
    ...shell("2026-10-28T01:01:00.000Z", "sh-1", ["ls"], "src"),
    ...call(
      "2026-10-28T01:02:00.000Z",
      "fn-1",
      "read_file",
      { path: "notes/active-context.md" },
      "current work",
    ),
    ...shell(
      "2026-10-28T01:03:00.000Z",
      "sh-2",
      ["cat", "/tmp/project/.env"],
      "SECRET=do-not-carry",
    ),
    ...call("2026-10-28T01:04:00.000Z", "fn-2", "grep", { pattern: "gap" }, "one match"),
    ...shell("2026-10-28T01:05:00.000Z", "sh-3", ["git", "status"], "clean"),
    message("2026-10-28T01:06:00.000Z", "assistant", "done for now"),
  ];
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const provider = new CodexProvider({
    host: { ...fixtureCodexHost, ...rolloutHost({ files: { [path]: lines.join("\n") + "\n" } }) },
  });
  const briefing = await provider.readRecycleBriefing?.({
    sessionId: THREAD,
    workingDirectory: "/work",
    budgetTokens: 8_000,
    envVars: { CODEX_HOME: "/codex-home" },
  });
  expect(briefing).toContain("done for now");
  expect(briefing).toContain("shell(command=git status)");
  expect(briefing).toContain("[withheld: sensitive path]");
  expect(briefing).not.toContain("SECRET=do-not-carry");
  expect(briefing).toContain("[… truncated — read the channel for the rest]");
  expect(briefing).not.toContain("A".repeat(12_000));

  const tight = await provider.readRecycleBriefing?.({
    sessionId: THREAD,
    workingDirectory: "/work",
    budgetTokens: 200,
    envVars: { CODEX_HOME: "/codex-home" },
  });
  expect(tight).toBeDefined();
  expect(tight!.length).toBeLessThanOrEqual(200 * 4);
  expect(tight).not.toContain("A".repeat(500));
});

test("a synthetic zero token count keeps the real context", async () => {
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const read = async (lines: string[]) => {
    const provider = new CodexProvider({
      host: { ...fixtureCodexHost, ...rolloutHost({ files: { [path]: lines.join("\n") + "\n" } }) },
    });
    return provider.readSessionResumeFacts?.({
      sessionId: THREAD,
      envVars: { CODEX_HOME: "/codex-home" },
    });
  };
  const measured = tokenCount("2026-10-28T01:00:00.000Z", 200_000);
  expect(
    await read([
      measured,
      usageCount(
        "2026-10-28T01:05:00.000Z",
        { input_tokens: 0, total_tokens: 40_000 },
        { input_tokens: 200_000, total_tokens: 240_000 },
      ),
    ]),
  ).toMatchObject({ lastContextTokens: 40_000 });
  expect(
    await read([
      measured,
      usageCount(
        "2026-10-28T01:06:00.000Z",
        { input_tokens: 0, total_tokens: 0 },
        { input_tokens: 0, total_tokens: 258_000 },
      ),
    ]),
  ).toMatchObject({ lastContextTokens: 258_000 });
  expect(
    await read([
      measured,
      usageCount(
        "2026-10-28T01:07:00.000Z",
        { input_tokens: 0, total_tokens: 0 },
        { input_tokens: 0, total_tokens: 0 },
      ),
    ]),
  ).toMatchObject({ lastContextTokens: 200_000 });
});

test("a shell withholds a secret that is not the final argument, or that is only the working directory", async () => {
  const lines = [
    ...shell(
      "2026-10-28T01:01:00.000Z",
      "sh-1",
      ["cat", "/tmp/project/.env", "notes.txt"],
      "SECRET_MID",
    ),
    ...shell("2026-10-28T01:02:00.000Z", "sh-2", ["zsh", "-lc", "cat .env && ls"], "SECRET_SCRIPT"),
    ...shell("2026-10-28T01:03:00.000Z", "sh-3", ["ls"], "SECRET_DIR", "/home/user/.ssh"),
    ...call("2026-10-28T01:04:00.000Z", "fn-1", "read_file", { path: "a.ts" }, "one"),
    ...call("2026-10-28T01:05:00.000Z", "fn-2", "grep", { pattern: "gap" }, "two"),
  ];
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const provider = new CodexProvider({
    host: { ...fixtureCodexHost, ...rolloutHost({ files: { [path]: lines.join("\n") + "\n" } }) },
  });
  const briefing = await provider.readRecycleBriefing?.({
    sessionId: THREAD,
    workingDirectory: "/work",
    budgetTokens: 8_000,
    envVars: { CODEX_HOME: "/codex-home" },
  });
  expect(briefing).toContain("[withheld: sensitive path]");
  expect(briefing).not.toContain("SECRET_MID");
  expect(briefing).not.toContain("SECRET_SCRIPT");
  expect(briefing).not.toContain("SECRET_DIR");
});

test("fewer than five actions, or an unreadable rollout, builds no briefing", async () => {
  const path = rolloutPath("/codex-home", "2026-10-28T01-00-00");
  const quiet = [
    message("2026-10-28T01:00:00.000Z", "user", "hello"),
    ...call("2026-10-28T01:01:00.000Z", "fn-1", "read_file", { path: "a" }, "b"),
  ].join("\n");
  const provider = new CodexProvider({
    host: { ...fixtureCodexHost, ...rolloutHost({ files: { [path]: quiet } }) },
  });
  expect(
    await provider.readRecycleBriefing?.({
      sessionId: THREAD,
      workingDirectory: "/work",
      budgetTokens: 8_000,
      envVars: { CODEX_HOME: "/codex-home" },
    }),
  ).toBeUndefined();
  const broken = new CodexProvider({
    host: {
      ...fixtureCodexHost,
      ...rolloutHost({ files: { [path]: "{" } }),
    },
  });
  expect(
    await broken.readRecycleBriefing?.({
      sessionId: THREAD,
      workingDirectory: "/work",
      budgetTokens: 8_000,
      envVars: { CODEX_HOME: "/codex-home" },
    }),
  ).toBeUndefined();
});
