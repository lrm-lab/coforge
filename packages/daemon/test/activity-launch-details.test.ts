import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "#src/code-agent/contract";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-launch-details-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  workspaceRoot,
  workspaceId: "workspace-a",
  computerId: "computer-a",
};
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
const agentLaunchConfig = (agentApiKey: string) => ({ agentApiKey, providerConfig: undefined });

function sessionSpy() {
  return {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
}

test("publishes current-launch command and tool Activity details", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
  const sessions: Array<{
    event(event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void;
    delayedExit(): void;
  }> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
        const exits: Array<() => void> = [];
        let exited = false;
        const control = {
          event: (event: Parameters<typeof listener>[0]) => listener(event),
          delayedExit: () => {
            for (const exit of exits) exit();
          },
        };
        sessions.push(control);
        return {
          ...sessionSpy(),
          subscribe(next) {
            listener = next;
            return () => undefined;
          },
          onExit(callback) {
            exits.push(callback);
            return () => undefined;
          },
          async dispose() {
            if (!exited) {
              exited = true;
              for (const exit of exits) exit();
            }
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(
            `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
          );
        },
        async revokeAgentApiKey() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    await runtime.start(connection);
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.handleAgentStart(intent);
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail:
          "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
        observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/input.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.100Z"),
        entries: [{ kind: "tool_start", toolName: "read_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/output.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.200Z"),
        entries: [{ kind: "tool_start", toolName: "write_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/existing.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.300Z"),
        entries: [{ kind: "tool_start", toolName: "edit_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "WebSearch query=CoForge",
        observedAtMs: Date.parse("2026-08-29T00:00:00.400Z"),
        entries: [{ kind: "tool_start", toolName: "WebSearch" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "request timed out: Bearer fixture-private-token",
        observedAtMs: Date.parse("2026-08-29T00:00:00.500Z"),
      },
    });
    const firstLaunch = activities[0]!.launchId;
    expect(firstLaunch).not.toBe("");
    expect(activities.every((activity) => activity.launchId === firstLaunch)).toBe(true);
    expect(activities.map(({ clientSeq }) => clientSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(activities[1]!.detail).toBe(
      "printf 0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012",
    );
    expect(activities.slice(2, 6).map(({ detail }) => detail)).toEqual([
      "/workspace/src/input.ts",
      "/workspace/src/output.ts",
      "/workspace/src/existing.ts",
      "WebSearch query=CoForge",
    ]);
    expect(activities[6]!.detail).toBe("request timed out: Bearer fixture-private-token");

    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_reconnecting",
        level: "info",
        detail: "Codex reconnecting to provider…",
        observedAtMs: Date.now(),
        entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
      },
    });
    expect(activities[7]).toMatchObject({
      detailKind: "runtime_reconnecting",
      level: "info",
      detail: "Codex reconnecting to provider…",
      entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
    });

    const stopping = runtime.stopAgent("agent-a");
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "late command",
        observedAtMs: Date.parse("2026-08-29T00:00:01.000Z"),
      },
    });
    await stopping;
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "running_command",
      "tool_started",
      "tool_started",
      "tool_started",
      "tool_started",
      "runtime_error",
      "runtime_reconnecting",
      "runtime_interrupted",
      "stopped",
    ]);

    await runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const beforeOldCallbacks = activities.length;
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "stale command",
        observedAtMs: Date.parse("2026-08-29T00:00:02.000Z"),
      },
    });
    sessions[0]!.delayedExit();
    expect(activities).toHaveLength(beforeOldCallbacks);
    expect(activities.at(-1)!.launchId).not.toBe(firstLaunch);
    expect(activities.at(-1)!.clientSeq).toBe(1);
  } finally {
    await runtime.stop();
  }
});
