import { readLocalSessionWindows } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import {
  readClaudeLocalSessionExcerpt,
  searchClaudeLocalSessions,
  type ClaudeDirectoryEntry,
  type ClaudeHistoryHost,
} from "@lrm/coforge-anvil/claude-code";
import {
  readCodexLocalSessionExcerpt,
  searchCodexLocalSessions,
  type CodexDirectoryEntry,
  type CodexHistoryHost,
} from "@lrm/coforge-anvil/codex";

const NOW = Date.parse("2026-11-02T02:00:00Z");
const limits = {
  maxResults: 100,
  maxDirectories: 100,
  maxFiles: 100,
  maxContentBytes: 64 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  deadlineAtMs: NOW + 2_000,
  now: () => NOW,
};

type FileNode = { text: string; mtimeMs: number; link?: boolean };

function directoryEntries(files: Map<string, FileNode>, path: string) {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const names = new Set<string>();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).split("/")[0];
    if (name) names.add(name);
  }
  return [...names];
}

function claudeHost(input: Record<string, FileNode>): ClaudeHistoryHost {
  const files = new Map(Object.entries(input));
  return {
    readHostEnvironment: (name) => (name === "CLAUDE_CONFIG_DIR" ? "/claude" : undefined),
    homeDirectory: () => "/home/test",
    async readDirectoryEntries(path) {
      return directoryEntries(files, path).map((name): ClaudeDirectoryEntry => ({
        name,
        isDirectory: () => [...files.keys()].some((key) => key.startsWith(`${path}/${name}/`)),
      }));
    },
    async readDirectoryNames(path) {
      return directoryEntries(files, path);
    },
    async lstat(path) {
      const file = files.get(path);
      const directory = [...files.keys()].some((key) => key.startsWith(`${path}/`));
      if (!file && !directory) throw new Error("missing");
      return {
        mtimeMs: file?.mtimeMs ?? 0,
        size: file?.text.length ?? 0,
        isDirectory: () => directory,
        isFile: () => Boolean(file && !file.link),
      };
    },
    async readFileTail(path, bytes) {
      const text = files.get(path)?.text;
      if (text === undefined) throw new Error("missing");
      const startOffset = Math.max(0, text.length - bytes);
      return { text: text.slice(startOffset), startOffset };
    },
    async readFileHead(path, bytes) {
      const text = files.get(path)?.text;
      if (text === undefined) throw new Error("missing");
      return text.slice(0, bytes);
    },
  };
}

function claudeRecord(
  type: string,
  timestamp: string,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type,
    timestamp,
    cwd: "/work/project",
    message: { role: type, model: "claude-sonnet-4-5", content },
    ...extra,
  });
}

test("Claude list/search and excerpt expose conversation text but not tools or reasoning", async () => {
  const path = "/claude/projects/-work-project/session-1.jsonl";
  const text = [
    claudeRecord("user", "2026-11-02T01:00:00Z", "Build the import pipeline"),
    claudeRecord("assistant", "2026-11-02T01:01:00Z", [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "tool_use", name: "Read", input: { file_path: "/secret" } },
      { type: "text", text: "I inspected the parser" },
    ]),
    claudeRecord("user", "2026-11-02T01:02:00Z", [
      { type: "text", text: "Continue the unfinished importer" },
    ]),
  ].join("\n");
  const host = claudeHost({ [path]: { text, mtimeMs: NOW - 60_000 } });

  const listed = await searchClaudeLocalSessions({ query: "", limits }, host);
  expect(listed.sessions).toEqual([
    expect.objectContaining({
      sessionId: "session-1",
      cwd: "/work/project",
      model: "claude-sonnet-4-5",
      title: "Build the import pipeline",
      matchKind: "recent",
    }),
  ]);
  const searched = await searchClaudeLocalSessions({ query: "unfinished", limits }, host);
  expect(searched.sessions[0]).toEqual(expect.objectContaining({ matchKind: "content" }));
  expect(searched.contentSearchComplete).toBeTrue();

  const excerpt = await readClaudeLocalSessionExcerpt(
    { sessionId: "session-1", cwd: "/work/project", limits },
    host,
  );
  expect(excerpt).toEqual(
    expect.objectContaining({
      initialRequest: "Build the import pipeline",
      model: "claude-sonnet-4-5",
      recentTurns: [
        expect.objectContaining({ role: "user", text: "Build the import pipeline" }),
        expect.objectContaining({ role: "assistant", text: "I inspected the parser" }),
        expect.objectContaining({ role: "user", text: "Continue the unfinished importer" }),
      ],
    }),
  );
  expect(JSON.stringify(excerpt)).not.toContain("secret reasoning");
  expect(JSON.stringify(excerpt)).not.toContain("file_path");
});

function codexHost(input: Record<string, FileNode>): CodexHistoryHost {
  const files = new Map(Object.entries(input));
  return {
    readHostEnvironment: (name) => (name === "CODEX_HOME" ? "/codex" : undefined),
    homeDirectory: () => "/home/test",
    async readDirectoryEntries(path) {
      return directoryEntries(files, path).map((name): CodexDirectoryEntry => {
        const full = `${path}/${name}`;
        const file = files.get(full);
        const directory = [...files.keys()].some((key) => key.startsWith(`${full}/`));
        return {
          name,
          isDirectory: () => directory,
          isFile: () => Boolean(file && !file.link),
          isSymbolicLink: () => Boolean(file?.link),
        };
      });
    },
    async readFileTail(path, bytes) {
      const text = files.get(path)?.text;
      if (text === undefined) throw new Error("missing");
      const startOffset = Math.max(0, text.length - bytes);
      return { text: text.slice(startOffset), startOffset };
    },
    async readFileHead(path, bytes) {
      const text = files.get(path)?.text;
      if (text === undefined) throw new Error("missing");
      return text.slice(0, bytes);
    },
  };
}

function codexLine(timestamp: string, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp, type, payload });
}

const THREAD = "11111111-2222-4333-8444-555555555555";

test("Codex keeps the newest rollout and returns the initial request plus recent messages", async () => {
  const oldPath = `/codex/sessions/2026/11/01/rollout-2026-11-01T01-00-00-${THREAD}.jsonl`;
  const path = `/codex/sessions/2026/11/02/rollout-2026-11-02T01-00-00-${THREAD}_new.jsonl`;
  const oldText = codexLine("2026-11-01T01:00:00Z", "session_meta", {
    id: THREAD,
    cwd: "/old",
  });
  const text = [
    codexLine("2026-11-02T01:00:00Z", "session_meta", { id: THREAD, cwd: "/work/codex" }),
    codexLine("2026-11-02T01:00:01Z", "turn_context", { model: "gpt-5.3-codex" }),
    codexLine("2026-11-02T01:00:02Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Repair the compiler" }],
    }),
    codexLine("2026-11-02T01:00:03Z", "response_item", {
      type: "local_shell_call",
      action: { command: ["cat", ".env"] },
    }),
    codexLine("2026-11-02T01:00:04Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The compiler now reaches codegen" }],
    }),
  ].join("\n");
  const host = codexHost({
    [oldPath]: { text: oldText, mtimeMs: 1 },
    [path]: { text, mtimeMs: NOW - 30_000 },
  });

  const searched = await searchCodexLocalSessions({ query: "codegen", limits }, host);
  expect(searched.sessions).toEqual([
    expect.objectContaining({
      sessionId: THREAD,
      cwd: "/work/codex",
      model: "gpt-5.3-codex",
      title: "Repair the compiler",
      matchKind: "content",
    }),
  ]);
  const excerpt = await readCodexLocalSessionExcerpt(
    { sessionId: THREAD, cwd: "/work/codex", limits },
    host,
  );
  expect(excerpt).toEqual(
    expect.objectContaining({
      initialRequest: "Repair the compiler",
      recentTurns: [
        expect.objectContaining({ role: "user", text: "Repair the compiler" }),
        expect.objectContaining({ role: "assistant", text: "The compiler now reaches codegen" }),
      ],
    }),
  );
  expect(JSON.stringify(excerpt)).not.toContain(".env");
});

test("content budget exhaustion is explicit and symlink sessions are ignored", async () => {
  const first = `/codex/sessions/2026/11/02/rollout-2026-11-02T01-00-00-${THREAD}.jsonl`;
  const linkedThread = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const linked = `/codex/sessions/2026/11/02/rollout-2026-11-02T02-00-00-${linkedThread}.jsonl`;
  const host = codexHost({
    [first]: { text: "x".repeat(200), mtimeMs: 1 },
    [linked]: { text: "needle", mtimeMs: 2, link: true },
  });
  const result = await searchCodexLocalSessions(
    { query: "needle", limits: { ...limits, maxContentBytes: 100 } },
    host,
  );
  expect(result.sessions).toEqual([]);
  expect(result.contentSearchComplete).toBeFalse();
  expect(result.scanComplete).toBeTrue();
});

test("overlapping head and tail windows project a JSONL record only once", async () => {
  const record = JSON.stringify({ type: "message", value: "once" });
  const text = `${"x".repeat(60)}\n${record}\n${"y".repeat(50)}\n`;
  const overlapLimits = {
    ...limits,
    maxFileBytes: 200,
    maxContentBytes: 200,
  };
  const read = await readLocalSessionWindows(
    "/session.jsonl",
    overlapLimits,
    {
      async readFileHead(_path, bytes) {
        return text.slice(0, bytes);
      },
      async readFileTail(_path, bytes) {
        const startOffset = Math.max(0, text.length - bytes);
        return { text: text.slice(startOffset), startOffset };
      },
    },
    { bytes: 200 },
  );
  expect(read?.records).toEqual([{ type: "message", value: "once" }]);
});

test("a stalled filesystem read returns an incomplete search at the deadline", async () => {
  const stalled = new Promise<readonly ClaudeDirectoryEntry[]>(() => {});
  const started = Date.now();
  const result = await searchClaudeLocalSessions(
    {
      query: "",
      limits: { ...limits, deadlineAtMs: started + 10, now: Date.now },
    },
    {
      ...claudeHost({}),
      readDirectoryEntries: () => stalled,
    },
  );
  expect(result).toEqual({
    sessions: [],
    scanComplete: false,
    contentSearchComplete: true,
  });
  expect(Date.now() - started).toBeLessThan(100);
});

test("a final candidate hydration timeout marks the listing incomplete", async () => {
  const path = "/claude/projects/-work/session-1.jsonl";
  const base = claudeHost({
    [path]: {
      text: claudeRecord("user", "2026-11-02T01:00:00Z", "unfinished"),
      mtimeMs: NOW,
    },
  });
  const started = Date.now();
  const result = await searchClaudeLocalSessions(
    {
      query: "",
      limits: { ...limits, deadlineAtMs: started + 10, now: Date.now },
    },
    {
      ...base,
      readFileHead: () => new Promise<string>(() => {}),
    },
  );
  expect(result.sessions).toEqual([]);
  expect(result.scanComplete).toBeFalse();
});

test("Claude stats and Codex directory observations use bounded concurrency", async () => {
  const claudeFiles: Record<string, FileNode> = {};
  for (let index = 0; index < 16; index++)
    claudeFiles[`/claude/projects/-work/session-${index}.jsonl`] = {
      text: claudeRecord("user", "2026-11-02T01:00:00Z", `task ${index}`),
      mtimeMs: index,
    };
  const claudeBase = claudeHost(claudeFiles);
  let activeClaude = 0;
  let maxClaude = 0;
  await searchClaudeLocalSessions(
    { query: "", limits },
    {
      ...claudeBase,
      async lstat(path) {
        activeClaude += 1;
        maxClaude = Math.max(maxClaude, activeClaude);
        await Promise.resolve();
        try {
          return await claudeBase.lstat(path);
        } finally {
          activeClaude -= 1;
        }
      },
    },
  );
  expect(maxClaude).toBeGreaterThan(1);
  expect(maxClaude).toBeLessThanOrEqual(16);

  const codexFiles: Record<string, FileNode> = {};
  for (let index = 0; index < 8; index++) {
    const id = `${String(index).padStart(8, "0")}-2222-4333-8444-555555555555`;
    codexFiles[`/codex/sessions/day-${index}/rollout-2026-11-02T01-00-0${index}-${id}.jsonl`] = {
      text: [
        codexLine("2026-11-02T01:00:00Z", "session_meta", { id, cwd: `/work/${index}` }),
        codexLine("2026-11-02T01:00:01Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `task ${index}` }],
        }),
      ].join("\n"),
      mtimeMs: index,
    };
  }
  const codexBase = codexHost(codexFiles);
  let activeCodex = 0;
  let maxCodex = 0;
  await searchCodexLocalSessions(
    { query: "", limits },
    {
      ...codexBase,
      async readDirectoryEntries(path) {
        const root = path === "/codex/sessions";
        if (!root) {
          activeCodex += 1;
          maxCodex = Math.max(maxCodex, activeCodex);
          await Promise.resolve();
        }
        try {
          return await codexBase.readDirectoryEntries(path);
        } finally {
          if (!root) activeCodex -= 1;
        }
      },
    },
  );
  expect(maxCodex).toBeGreaterThan(1);
  expect(maxCodex).toBeLessThanOrEqual(8);
});
