import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import type { AgentActivity, AgentStartOpenTasks } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-startup-silent-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

async function harness() {
  const connection = { workspaceId: "workspace-a", computerId: "computer-a", workspaceRoot };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  let emit: (event: AgentRuntimeEvent) => void = () => {};
  let live = false;
  const session: AgentSession = {
    get hasLiveTurn() {
      return live;
    },
    async sendMessage() {
      live = true;
      emit({ type: "thinking-delta", text: "" });
      emit({ type: "completed", status: "completed" });
    },
    async notify() {},
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    async interrupt() {},
    async dispose() {},
  };
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "kiro",
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
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentStatus() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  return { runtime, activities };
}

const runtimeErrors = (activities: readonly AgentActivity[]) =>
  activities.filter((activity) => activity.detailKind === "runtime_error");

async function startSilent(
  h: Awaited<ReturnType<typeof harness>>,
  openTasks?: AgentStartOpenTasks,
) {
  await h.runtime.startAgent(
    "agent-a",
    { provider: "kiro", model: "auto", reasoning: "" },
    undefined,
    "recovery",
    openTasks ? { openTasks } : undefined,
  );
}

test("a silent startup completion settles idle instead of zero-evidence runtime error", async () => {
  const h = await harness();
  try {
    await startSilent(h);
    expect(runtimeErrors(h.activities)).toEqual([]);
    expect(h.activities.some((activity) => activity.detailKind === "idle")).toBe(true);
  } finally {
    await h.runtime.stop();
  }
});

test("a silent startup completion with open tasks remains zero-evidence", async () => {
  const h = await harness();
  try {
    await startSilent(h, {
      tasks: [{ ref: "#coforge:#12", title: "Ship the fix", status: "in_progress" }],
      more: 0,
    });
    expect(
      runtimeErrors(h.activities).some((activity) =>
        activity.detail?.includes("zero_evidence_turn_completed"),
      ),
    ).toBe(true);
  } finally {
    await h.runtime.stop();
  }
});
