import { expect, test } from "bun:test";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type AgentSession,
} from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/coforge-fast-mode-runtime",
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

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

function agentLaunchConfig(agentApiKey: string) {
  return { agentApiKey, providerConfig: undefined };
}

function harness() {
  let listener: (event: AgentRuntimeEvent) => void = () => undefined;
  const credentials = new InMemoryDaemonCredentialStore();
  const tiers: import("@lrm/coforge-sdk/internal").AgentServiceTier[] = [];
  const activities: Array<{ detailKind: string; level: string; detail: string }> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        return {
          ...sessionSpy(),
          subscribe(next) {
            listener = next;
            return () => undefined;
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
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentServiceTier(message) {
          tiers.push(message);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  return {
    runtime,
    tiers,
    activities,
    credentials,
    emit: (event: AgentRuntimeEvent) => listener(event),
    warnings: () => activities.filter(({ detailKind }) => detailKind === "fast_mode_unavailable"),
  };
}

async function seededHarness(fastMode: boolean, sessionId?: string) {
  const subject = harness();
  await subject.credentials.save(connection.workspaceId, connection.computerId, "token-a");
  await subject.runtime.start(connection);
  await subject.runtime.startAgent(
    "agent-a",
    fastMode ? { ...config, fastMode: true } : config,
    sessionId,
  );
  return subject;
}

test("sends a launch's observed service tier once, and warns once when Fast is not applied", async () => {
  const subject = await seededHarness(true, "known-session");
  try {
    subject.emit({
      type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER,
      state: "off",
      reason: "extra_usage_disabled",
    });
    expect(subject.tiers).toHaveLength(1);
    expect(subject.tiers[0]).toMatchObject({
      agentId: "agent-a",
      provider: "pi",
      sessionId: "known-session",
      requested: true,
      observed: "off",
    });
    expect(subject.warnings()).toHaveLength(1);
    expect(subject.warnings()[0]?.level).toBe("warning");
    // The runtime's own explanation reaches the row rather than only the fact that it failed.
    expect(subject.warnings()[0]?.detail).toContain("extra_usage_disabled");
    // An unchanged reading is neither re-sent nor warned about twice.
    subject.emit({ type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER, state: "off" });
    expect(subject.tiers).toHaveLength(1);
    expect(subject.warnings()).toHaveLength(1);
    // A changed reading is reported; the earlier warning stands on its own.
    subject.emit({ type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER, state: "on" });
    expect(subject.tiers).toHaveLength(2);
    expect(subject.tiers[1]).toMatchObject({ observed: "on" });
    // Same shared per-launch counter as Activity: strictly advancing, never repeating.
    expect(subject.tiers[1]!.clientSeq).toBeGreaterThan(subject.tiers[0]!.clientSeq);
    expect(subject.warnings()).toHaveLength(1);
  } finally {
    await subject.runtime.stop();
  }
});

test("says nothing about a service tier for a launch that did not ask for Fast mode", async () => {
  const subject = await seededHarness(false, "known-session");
  try {
    subject.emit({ type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER, state: "off" });
    subject.emit({ type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER, state: "on" });
    expect(subject.tiers).toEqual([]);
    expect(subject.warnings()).toEqual([]);
  } finally {
    await subject.runtime.stop();
  }
});

test("does not report a tier before the launch's session id is known", async () => {
  // A fresh managed start reports its identity only after the first turn; a reading that arrives
  // before then has no session to attach to, and must not throw in the event path.
  const subject = await seededHarness(true);
  try {
    subject.emit({ type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER, state: "on" });
    expect(subject.tiers).toEqual([]);
  } finally {
    await subject.runtime.stop();
  }
});
