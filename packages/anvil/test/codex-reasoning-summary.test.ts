import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider, type CodexRuntimeHost } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-summary-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const CODEX_HOME = "/home/fixture/.codex";
const CONFIG_PATH = join(CODEX_HOME, "config.toml");

function provider(readFileText: (path: string) => Promise<string>): CodexProvider {
  const host: CodexRuntimeHost = { ...fixtureCodexHost, readFileText };
  return new CodexProvider({
    host,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server-scenarios.ts", import.meta.url).pathname,
      `log=${join(directory, "requests.jsonl")}`,
    ],
  });
}

function open(codex: CodexProvider, sessionId?: string) {
  return codex.createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test Agent instructions.",
    environment: { HOME: "/home/fixture", CODEX_HOME },
    sessionId,
  });
}

async function threadConfig(method: "thread/start" | "thread/resume") {
  const log = await readFile(join(directory, "requests.jsonl"), "utf8");
  const request = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .find((entry) => entry.method === method);
  return request?.params?.config as Record<string, unknown> | undefined;
}

test("Codex asks for reasoning summaries when the user has not chosen one", async () => {
  const paths: string[] = [];
  const session = await open(
    provider(async (path) => {
      paths.push(path);
      throw new Error("no config file");
    }),
  );
  try {
    expect(paths).toEqual([CONFIG_PATH]);
    expect((await threadConfig("thread/start"))?.model_reasoning_summary).toBe("auto");
  } finally {
    await session.dispose();
  }
});

test("a resumed Codex session asks for reasoning summaries too", async () => {
  const session = await open(
    provider(async () => ""),
    "thread-1",
  );
  try {
    expect((await threadConfig("thread/resume"))?.model_reasoning_summary).toBe("auto");
  } finally {
    await session.dispose();
  }
});

test("the user's own reasoning summary setting wins", async () => {
  const session = await open(
    provider(async () => '# personal settings\nmodel_reasoning_summary = "none"\n'),
  );
  try {
    expect(await threadConfig("thread/start")).not.toHaveProperty("model_reasoning_summary");
  } finally {
    await session.dispose();
  }
});

test("a reasoning summary set in a profile counts as the user's choice", async () => {
  const session = await open(
    provider(async () => '[profiles.work]\nmodel_reasoning_summary = "concise"\n'),
  );
  try {
    expect(await threadConfig("thread/start")).not.toHaveProperty("model_reasoning_summary");
  } finally {
    await session.dispose();
  }
});
