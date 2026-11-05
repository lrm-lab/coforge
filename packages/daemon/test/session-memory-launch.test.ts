import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-session-memory-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** The runtime with a provider whose session records every input it is handed. */
async function harness() {
  const inputs: string[] = [];
  let settle: () => void = () => {};
  const answered = new Promise<void>((resolve) => (settle = resolve));
  let listener: (event: AgentRuntimeEvent) => void = () => undefined;
  const session = {
    async sendMessage(text: string) {
      inputs.push(text);
      settle();
    },
    async notify(text: string) {
      inputs.push(text);
      settle();
    },
    subscribe(next: (event: AgentRuntimeEvent) => void) {
      listener = next;
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  return {
    runtime,
    inputs,
    answered,
    emit: (event: AgentRuntimeEvent) => listener(event),
    stop: () => runtime.stop(),
  };
}

test("a fresh session's first input carries its MEMORY.md and stops asking for the file", async () => {
  const subject = await harness();
  try {
    await subject.runtime.startAgent("agent-a", config);
    await subject.answered;
    expect(subject.inputs[0]).toContain("<memory-index");
    expect(subject.inputs[0]).toContain("You are starting a fresh session.");
    // The seeded MEMORY.md fits the budget, so the block is complete and the starter says so.
    expect(subject.inputs[0]).not.toContain("read MEMORY.md and");
    expect(subject.inputs[0]).toContain("read notes/active-context.md");
  } finally {
    await subject.stop();
  }
});

test("a resumed session is handed no block: its context is still there", async () => {
  const subject = await harness();
  try {
    await subject.runtime.startAgent("agent-a", config, "known-session");
    await subject.answered;
    expect(subject.inputs[0]).not.toContain("<memory-index");
    expect(subject.inputs[0]).toContain("read MEMORY.md");
  } finally {
    await subject.stop();
  }
});

test("an explicit create never resumes, and opens with the block", async () => {
  const subject = await harness();
  try {
    await subject.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      "create",
    );
    await subject.answered;
    expect(subject.inputs[0]).toContain("<memory-index");
  } finally {
    await subject.stop();
  }
});

test("a finished compaction queues the block again for the next input", async () => {
  const subject = await harness();
  try {
    await subject.runtime.startAgent("agent-a", config);
    await subject.answered;
    subject.emit({ type: "compaction-started" });
    subject.emit({ type: "compaction-finished" });
    for (let i = 0; i < 50 && subject.inputs.length < 2; i++) await Bun.sleep(10);
    expect(subject.inputs).toHaveLength(2);
    expect(subject.inputs[1]).toContain("<memory-index");
    expect(subject.inputs[1]).toContain("your next input follows");
  } finally {
    await subject.stop();
  }
});
