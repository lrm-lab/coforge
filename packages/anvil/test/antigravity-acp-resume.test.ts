import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityAcpProvider,
  type AntigravityAcpRuntimeHost,
} from "@lrm/coforge-anvil/antigravity";
import { fixtureAntigravityHost } from "./fixtures/antigravity-host";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname;

async function openResumed(sessionId: string, env: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "agy-resume-"));
  const log = join(cwd, "rpc.jsonl");
  const host: AntigravityAcpRuntimeHost = {
    ...fixtureAntigravityHost,
    versionReader: async () => "1.5.10",
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    buildEnvironment: () => ({ ...env, AGY_ACP_FIXTURE_LOG: log }),
  };
  let replaced: string | undefined;
  const provider = new AntigravityAcpProvider({
    command: [process.execPath, FIXTURE],
    host,
    acpTimeoutMs: 5_000,
  });
  const session = await provider.createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Updated standing prompt",
    sessionId,
    sessionMode: "resume",
    onSessionId: async (_next, old) => {
      replaced = old;
    },
  });
  const requests = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  await session.dispose();
  await rm(cwd, { recursive: true, force: true });
  return { requests, replaced };
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
