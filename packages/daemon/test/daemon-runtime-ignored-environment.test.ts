import { expect, test } from "bun:test";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/coforge-ignored-environment-runtime",
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function harness(envVars: Record<string, string>) {
  let listener: (event: AgentRuntimeEvent) => void = () => undefined;
  const session = {
    async sendMessage() {},
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
  const activities: Array<{ detailKind: string; level: string; detail: string }> = [];
  const credentials = new InMemoryDaemonCredentialStore();
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
          return { agentApiKey: `sk_agent_${"a".repeat(43)}`, envVars };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  return { runtime, activities, credentials, emit: (event: AgentRuntimeEvent) => listener(event) };
}

async function launch(envVars: Record<string, string>) {
  const subject = harness(envVars);
  await subject.credentials.save(connection.workspaceId, connection.computerId, "token-a");
  await subject.runtime.start(connection);
  await subject.runtime.startAgent("agent-a", config, "known-session");
  return subject;
}

test("reports each reserved stored variable the launch skipped, and the ordinary ones stay unreported", async () => {
  const subject = await launch({ NODE_OPTIONS: "--require ./x.js", MY_VAR: "kept" });
  try {
    const warnings = subject.activities.filter(({ level }) => level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      detailKind: "agent_environment_ignored",
      agentId: "agent-a",
    });
    expect(warnings[0]?.detail).toContain("NODE_OPTIONS");
    expect(warnings[0]?.detail).not.toContain("MY_VAR");
  } finally {
    await subject.runtime.stop();
  }
});

test("reports nothing for an ordinary stored environment", async () => {
  const subject = await launch({ MY_VAR: "kept" });
  try {
    expect(subject.activities.filter(({ level }) => level === "warning")).toEqual([]);
  } finally {
    await subject.runtime.stop();
  }
});
