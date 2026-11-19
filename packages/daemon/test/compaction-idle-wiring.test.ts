import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-idle-compaction-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("a Claude Code idle /compact holds its line for the next reading, which the next turn's end supplies", async () => {
  const { records } = await captureDaemonLogs(async () => {
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    let live = false;
    const provider: CodeAgentProvider = {
      provider: "claude-code",
      reportsCompaction: true,
      async createAgentSession(options) {
        await options.onSessionId?.("claude-session-1");
        return {
          get hasLiveTurn() {
            return live;
          },
          async sendMessage(text) {
            live = true;
            if (text !== "/compact") {
              listener({ type: "text-delta", text: "boot" });
              live = false;
              listener({ type: "completed", status: "completed" });
              return;
            }
            setTimeout(() => {
              listener({ type: "compaction-started" });
              listener({ type: "compaction-finished" });
              live = false;
              listener({ type: "completed", status: "completed" });
            }, 15);
          },
          async notify() {},
          subscribe(next) {
            listener = next;
            return () => undefined;
          },
          async interrupt() {},
          onExit() {
            return () => undefined;
          },
          async dispose() {},
        };
      },
    };
    const connection = {
      computerId: "computer-idle-compaction",
      workspaceId: "workspace-idle-compaction",
      workspaceRoot: join(tempDir, "workspace"),
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => provider,
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async reportAgentSession() {},
          sendAgentActivity() {},
          async requestAgentLaunchConfig(req) {
            return { agentApiKey: `sk_agent_${req.agentId.padEnd(43, "a").slice(0, 43)}` };
          },
          async revokeAgentApiKey() {},
          async agentTaskIdleNudge() {
            return { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      join(tempDir, "state"),
    );
    await runtime.start(connection);
    try {
      await runtime.startAgent("agent-claude", {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        reasoning: "balanced",
      });
      await Bun.sleep(20);
      live = true;
      listener({ type: "context-usage", usedTokens: 260_000, windowTokens: 500_000 });
      listener({ type: "text-delta", text: "work" });
      live = false;
      listener({ type: "completed", status: "completed" });
      for (let i = 0; i < 60; i++) await Bun.sleep(10);
      live = true;
      listener({ type: "context-usage", usedTokens: 64_000, windowTokens: 500_000 });
      listener({ type: "text-delta", text: "later work" });
      live = false;
      listener({ type: "completed", status: "completed" });
      await Bun.sleep(30);
    } finally {
      await runtime.stop();
    }
  });
  const written = records
    .map((record) => record.properties)
    .filter((properties) => properties.event === "agent.runtime.compaction_tokens");
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({
    idle_compaction: true,
    tokens_before: 260_000,
    tokens_after: 64_000,
    tokens_source: "reading_after_more_work",
  });
});
