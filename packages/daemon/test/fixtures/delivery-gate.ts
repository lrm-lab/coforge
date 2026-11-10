import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";

/** A fake session whose `subscribe` listener the test drives directly, so it can
 * simulate a provider's busy/idle transitions (`progress` while a turn runs, `completed` at turn
 * end) without a real provider process. */
export function deliveryGateSession() {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const exitListeners = new Set<() => void>();
  const notices: string[] = [];
  const waiters: Array<{ length: number; resolve: () => void }> = [];
  const disposed = Promise.withResolvers<void>();
  return {
    session: {
      async sendMessage() {
        // These tests exercise delivery after successful startup, not a provider still
        // waiting for its first model event.
        for (const listener of listeners) listener({ type: "completed", status: "completed" });
      },
      async notify(notice: string) {
        notices.push(notice);
        // Iterate backward while splicing so removing an earlier waiter never shifts a not-yet-
        // visited one out from under the loop.
        for (let index = waiters.length - 1; index >= 0; index--) {
          const waiter = waiters[index]!;
          if (notices.length >= waiter.length) {
            waiters.splice(index, 1);
            waiter.resolve();
          }
        }
      },
      subscribe(listener: (event: AgentRuntimeEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async interrupt() {},
      onExit(listener: () => void) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      async dispose() {
        disposed.resolve();
      },
    } satisfies AgentSession,
    notices,
    /** Resolves once the runtime has asked this session to exit (process end observed). */
    disposed: disposed.promise,
    emit: (event: AgentRuntimeEvent) => {
      for (const listener of listeners) listener(event);
    },
    /** Simulates the runtime process exiting unexpectedly (a crash), firing every `onExit`
     * listener DaemonRuntime has registered across every launch that used this session. */
    exit: () => {
      for (const listener of exitListeners) listener();
    },
    /** Resolves once at least `length` notices have been sent — the observable completion of a
     * fire-and-forget release, rather than a timer-based wait (docs/agents/testing.md). */
    waitForNotices: (length: number) =>
      notices.length >= length
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ length, resolve })),
  };
}

/** Resolves once `sendAgentDeliveryAck` has recorded `count` deliveries — the observable
 * completion of a flush, rather than a timer-based wait (docs/agents/testing.md). */
export function ackGate(count: number) {
  const acks: string[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return {
    acks,
    done,
    record(deliveryId: string) {
      acks.push(deliveryId);
      if (acks.length >= count) resolve();
    },
  };
}

/** A DaemonRuntime over `deliveryGateSession` for the delivery-gate tests: no provider
 * process, every delivery answered through the fake session, and the connection's own ports
 * recording the acks, rejections, activities and statuses a test asserts on. */
export async function createDeliveryGateHarness({
  connection,
  config,
  provider,
  acks = ackGate(0),
  stateDirectory,
  onActivity,
  agentConfig = {},
}: {
  connection: WorkspaceConfig;
  config: AgentRuntimeConfig;
  provider: AgentRuntimeConfig["provider"];
  acks?: ReturnType<typeof ackGate>;
  stateDirectory?: string;
  onActivity?: (activity: AgentActivity) => void;
  agentConfig?: Partial<AgentRuntimeConfig>;
}) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const fake = deliveryGateSession();
  const statuses: AgentStatus[] = [];
  const rejections: { reason: string }[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider, createAgentSession: async () => fake.session }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck(ack) {
          acks.record(ack.deliveryId);
        },
        async sendAgentDeliveryRejection(rejection) {
          rejections.push(rejection);
        },
        sendAgentActivity(activity) {
          onActivity?.(activity);
        },
        sendAgentStatus(status) {
          statuses.push(status);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", { ...config, provider, ...agentConfig });
  return {
    runtime,
    fake,
    acks,
    statuses,
    rejections,
    deliver: (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: `body-${sequence}`,
        method: "agent:v1:message:deliver",
        target: "@ada",
      }),
  };
}
