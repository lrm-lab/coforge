import type { AgentActivity, AgentActivityDetailKind } from "@lrm/coforge-sdk/internal";
import type { AgentReplyIntent } from "@lrm/coforge-sdk/internal/reply-intent";
import type { AgentRuntimeEvent, AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";

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

const config = {
  provider: "pi" as const,
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** Boots a runtime whose one Agent session hands the test direct control over runtime events. */
export async function activityHarness(connection: WorkspaceConfig, provider?: CodeAgentProvider) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const replyIntents: AgentReplyIntent[] = [];
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
  const runtime = new DaemonRuntime(
    connection,
    () =>
      provider ?? {
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
      },
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentReplyIntent(frame) {
          replyIntents.push(frame);
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  const agent = await runtime.startAgent(
    "agent-a",
    provider ? { ...config, provider: provider.provider } : config,
  );
  return {
    runtime,
    session: agent.session,
    activities,
    replyIntents,
    emit(activity: {
      detailKind: AgentActivityDetailKind;
      level: AgentActivity["level"];
      detail: string;
      entries?: AgentActivity["entries"];
    }) {
      listener({ type: "activity", activity: { ...activity, observedAtMs: Date.now() } });
    },
    /** Raw AgentRuntimeEvent injection, for events with no activity shorthand
     * (tool-end, completed). */
    emitEvent(event: AgentRuntimeEvent) {
      listener(event);
    },
  };
}
