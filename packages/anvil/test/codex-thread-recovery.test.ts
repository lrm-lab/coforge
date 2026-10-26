import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexProvider } from "@lrm/coforge-anvil/codex";
import { AgentSessionRecoveryError } from "@lrm/coforge-anvil";
import { scenarioProvider } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-thread-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function provider(...scenarios: string[]): CodexProvider {
  return scenarioProvider(
    `log=${join(directory, "requests.jsonl")}`,
    ...scenarios.map((scenario) => `scenario=${scenario}`),
  );
}

async function requests(method: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(directory, "requests.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((request) => request.method === method);
}

function open(
  codex: CodexProvider,
  options: { sessionId?: string; name?: string } = {},
): {
  reports: Array<[string, string | undefined]>;
  session: ReturnType<typeof create>;
} {
  const reports: Array<[string, string | undefined]> = [];
  const session = create(codex, options, reports);
  return { reports, session };
}

function create(
  codex: CodexProvider,
  options: { sessionId?: string; name?: string },
  reports: Array<[string, string | undefined]>,
) {
  return codex.createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test Agent instructions.",
    sessionId: options.sessionId,
    ...(options.name ? { environment: { COFORGE_CURRENT_AGENT_NAME: options.name } } : {}),
    async onSessionId(id, replaced) {
      reports.push([id, replaced]);
    },
  });
}

test("Codex unarchives an archived thread and resumes it", async () => {
  const { reports, session } = open(provider("archived"), {
    sessionId: "thread-old",
  });
  const opened = await session;
  try {
    expect(reports).toEqual([["thread-old", undefined]]);
    expect(await opened.readSessionIdentity!()).toEqual({
      sessionId: "thread-old",
      state: "resumable",
    });
    expect((await requests("thread/unarchive")).map((request) => request.params)).toEqual([
      { threadId: "thread-old" },
    ]);
    expect(await requests("thread/resume")).toHaveLength(2);
  } finally {
    await opened.dispose();
  }
});

for (const scenario of ["unarchive-fails", "still-archived"]) {
  test(`Codex starts a fresh thread when an archived one cannot be recovered (${scenario})`, async () => {
    const { reports, session } = open(provider("archived", scenario), {
      sessionId: "thread-old",
    });
    const opened = await session;
    try {
      expect(reports).toEqual([["thread-1", "thread-old"]]);
      expect(await opened.readSessionIdentity!()).toEqual({
        sessionId: "thread-1",
        state: "empty",
      });
      expect(await requests("thread/unarchive")).toHaveLength(1);
    } finally {
      await opened.dispose();
    }
  });
}

test("Codex reports a thread with an active writer as session_in_use", async () => {
  const { session } = open(provider("active-writer"), {
    sessionId: "thread-old",
  });
  await expect(session).rejects.toEqual(new AgentSessionRecoveryError("session_in_use"));
  expect(await requests("thread/unarchive")).toHaveLength(0);
});

test("Codex names a fresh thread after the Agent", async () => {
  const { session } = open(provider(), { name: " Ada " });
  await (await session).dispose();
  expect((await requests("thread/name/set")).map((request) => request.params)).toEqual([
    { threadId: "thread-1", name: "CoForge · Ada" },
  ]);
});

test("Codex names a recovered thread that has no name", async () => {
  const { session } = open(provider("archived"), {
    sessionId: "thread-old",
    name: "Ada",
  });
  await (await session).dispose();
  expect((await requests("thread/name/set")).map((request) => request.params)).toEqual([
    { threadId: "thread-old", name: "CoForge · Ada" },
  ]);
});

test("Codex leaves a named thread and a nameless launch alone", async () => {
  await (await open(provider("named-thread"), { name: "Ada" }).session).dispose();
  await (await open(provider()).session).dispose();
  expect(await requests("thread/name/set")).toEqual([]);
});

test("Codex launches even when naming the thread fails", async () => {
  const { reports, session } = open(provider("name-set-fails"), {
    name: "Ada",
  });
  const opened = await session;
  try {
    expect(reports).toEqual([["thread-1", undefined]]);
    expect(await requests("thread/name/set")).toHaveLength(1);
  } finally {
    await opened.dispose();
  }
});

test("Codex reports an active writer found after unarchiving as session_in_use", async () => {
  const { session } = open(provider("archived", "active-writer"), { sessionId: "thread-old" });
  await expect(session).rejects.toEqual(new AgentSessionRecoveryError("session_in_use"));
  expect(await requests("thread/unarchive")).toHaveLength(1);
});
