import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  AntigravityAcpProvider,
  type AntigravityAcpRuntimeHost,
} from "@lrm/coforge-anvil/antigravity";
import { fixtureAntigravityHost } from "./fixtures/antigravity-host";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname;

async function openResumed(
  sessionId: string,
  env: Record<string, string>,
  options: {
    error?: string;
    prompt?: string;
    timeoutMs?: number;
    runtime?: AgentSessionOptions["runtime"];
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "agy-resume-"));
  const log = join(cwd, "rpc.jsonl");
  const host: AntigravityAcpRuntimeHost = {
    ...fixtureAntigravityHost,
    versionReader: async () => "1.5.10",
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    buildEnvironment: () => ({ ...env, AGY_ACP_FIXTURE_LOG: log }),
  };
  const bindings: Array<{ sessionId: string; replaced?: string }> = [];
  const provider = new AntigravityAcpProvider({
    command: [process.execPath, FIXTURE],
    host,
    acpTimeoutMs: options.timeoutMs ?? 5_000,
  });
  try {
    const opening = provider.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Updated standing prompt",
      sessionId,
      sessionMode: "resume",
      runtime: options.runtime,
      onSessionId: async (next, replaced) => {
        bindings.push({ sessionId: next, replaced });
      },
    });
    if (options.error) {
      await expect(opening.then((session) => session.dispose())).rejects.toThrow(options.error);
    } else {
      const session = await opening;
      try {
        if (options.prompt) await session.sendMessage(options.prompt);
      } finally {
        await session.dispose();
      }
    }
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    return { requests, bindings, replaced: bindings[0]?.replaced };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("uses session/resume with systemPrompt.append when advertised", async () => {
  const { requests, replaced } = await openResumed("existing-session", {
    AGY_ACP_FIXTURE_RESUME_CAP: "1",
  });
  const methods = requests.map((r) => r.method);
  expect(methods).toContain("session/resume");
  expect(methods).not.toContain("session/load");
  expect(methods).not.toContain("session/new");
  expect(replaced).toBeUndefined();
  const resumeCall = requests.find((r) => r.method === "session/resume");
  expect(resumeCall?.params).toMatchObject({
    sessionId: "existing-session",
    mcpServers: [],
    _meta: { antigravity: { systemPrompt: { append: "Updated standing prompt" } } },
  });
});

test("falls back to session/load when session/resume returns -32601 or -32602", async () => {
  for (const code of ["-32601", "-32602"]) {
    const { requests, replaced } = await openResumed("existing-session", {
      AGY_ACP_FIXTURE_RESUME_CAP: "1",
      AGY_ACP_FIXTURE_RESUME_ERROR: code,
    });
    const methods = requests.map((r) => r.method);
    expect(methods).toContain("session/resume");
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(replaced).toBeUndefined();
  }
});

test("replaces missing session directly with session/new when session/resume returns -32002", async () => {
  const { requests, replaced } = await openResumed("missing-session", {
    AGY_ACP_FIXTURE_RESUME_CAP: "1",
  });
  const methods = requests.map((r) => r.method);
  expect(methods).toContain("session/resume");
  expect(methods).not.toContain("session/load");
  expect(methods).toContain("session/new");
  expect(replaced).toBe("missing-session");
});

test("uses session/load directly when sessionCapabilities.resume is not advertised", async () => {
  const { requests } = await openResumed("existing-session", {});
  const methods = requests.map((r) => r.method);
  expect(methods).not.toContain("session/resume");
  expect(methods).toContain("session/load");
});

function listing(pages: unknown[]) {
  return {
    AGY_ACP_FIXTURE_RESUME_CAP: "1",
    AGY_ACP_FIXTURE_LIST_PAGES: JSON.stringify(pages),
  };
}

test("finds the stored session on a later page and sends the prompt once", async () => {
  const { requests, bindings } = await openResumed(
    "existing-session",
    listing([
      { sessions: [{ sessionId: "other-session", cwd: "workspace" }], nextCursor: "page-2" },
      { sessions: [{ sessionId: "existing-session", cwd: "workspace" }] },
    ]),
    { prompt: "pending input" },
  );
  expect(
    requests.filter((request) => request.method === "session/list").map((r) => r.params),
  ).toEqual([{}, { cursor: "page-2" }]);
  expect(requests.map((request) => request.method)).not.toContain("session/new");
  expect(bindings).toEqual([{ sessionId: "existing-session", replaced: undefined }]);
  expect(requests.filter((request) => request.method === "session/prompt")).toMatchObject([
    {
      params: { sessionId: "existing-session", prompt: [{ type: "text", text: "pending input" }] },
    },
  ]);
});

test("replaces a session omitted by a complete list and only sends to the replacement", async () => {
  const { requests, bindings } = await openResumed(
    "false-success-session",
    listing([
      { sessions: [{ sessionId: "other-session", cwd: "workspace" }], nextCursor: "page-2" },
      { sessions: [], nextCursor: null },
    ]),
    { prompt: "pending input" },
  );
  expect(requests.map((request) => request.method)).not.toContain("session/resume");
  expect(requests.map((request) => request.method)).not.toContain("session/load");
  expect(bindings).toEqual([
    { sessionId: "agy-acp-fixture-session", replaced: "false-success-session" },
  ]);
  expect(requests.filter((request) => request.method === "session/prompt")).toMatchObject([
    {
      params: {
        sessionId: "agy-acp-fixture-session",
        prompt: [{ type: "text", text: "pending input" }],
      },
    },
  ]);
});

test.each([
  [
    "other directory",
    [{ sessions: [{ sessionId: "existing-session", cwd: "/other" }] }],
    "different working directory",
  ],
  [
    "missing directory",
    [{ sessions: [{ sessionId: "existing-session" }] }],
    "invalid session list",
  ],
  ["missing sessions", [{}], "invalid session list"],
  ["invalid cursor", [{ sessions: [], nextCursor: 123 }], "invalid session list cursor"],
  [
    "repeated cursor",
    [
      { sessions: [], nextCursor: "again" },
      { sessions: [], nextCursor: "again" },
    ],
    "incomplete session list",
  ],
  ["RPC failure", [{ sessions: [], nextCursor: "page-2" }, -32603], "session/list failed"],
  ["sign-in required", [-32000], "Antigravity is not signed in"],
])("keeps the original session on %s", async (_case, pages, error) => {
  const { requests, bindings } = await openResumed("existing-session", listing(pages), { error });
  expect(bindings).toEqual([]);
  expect(requests.map((request) => request.method)).not.toContain("session/resume");
  expect(requests.map((request) => request.method)).not.toContain("session/load");
  expect(requests.map((request) => request.method)).not.toContain("session/new");
  expect(requests.map((request) => request.method)).not.toContain("session/prompt");
});

test("a session list timeout preserves the previous session", async () => {
  const { requests, bindings } = await openResumed("existing-session", listing(["hang"]), {
    timeoutMs: 500,
    error: "agy acp session/list timed out",
  });
  expect(requests.map((request) => request.method)).toEqual(["initialize", "session/list"]);
  expect(bindings).toEqual([]);
});

test.each(["resume", "load"])(
  "rejects a different session ID reported by session/%s",
  async (method) => {
    const { requests, bindings } = await openResumed(
      "existing-session",
      {
        ...(method === "resume" ? { AGY_ACP_FIXTURE_RESUME_CAP: "1" } : {}),
        AGY_ACP_FIXTURE_OPENED_ID: "different-session",
      },
      { error: "agy acp opened a different session" },
    );
    expect(requests.map((request) => request.method)).toEqual(["initialize", `session/${method}`]);
    expect(bindings).toEqual([]);
  },
);

test("keeps the existing binding when applying effort changes the selected model", async () => {
  const { requests, bindings } = await openResumed(
    "existing-session",
    { AGY_ACP_FIXTURE_CHANGE_MODEL_ON_EFFORT: "1" },
    {
      runtime: {
        provider: RUNTIME_PROVIDER.ANTIGRAVITY,
        model: "gemini-4-carbon",
        reasoning: "high",
      },
      error: "agy acp changed the model while applying thought_level",
    },
  );
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "session/load",
    "session/set_mode",
    "session/set_config_option",
  ]);
  expect(bindings).toEqual([]);
});
