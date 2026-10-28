import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@lrm/coforge-anvil";
import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
/** The state directory this file's runtimes read, and the one its tests seed. */
export const workspaceRoot = join(tempRoot, `coforge-mention-delivery-${crypto.randomUUID()}`);
export const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
export const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** One frame the daemon sent the cloud about a delivery, in the order it sent them. */
export type Frame =
  | { kind: "ack"; deliveryId: string; mentionDelivery?: MentionDeliveryEnvelope }
  | { kind: "transition"; deliveryId: string; stage: string; outcome: string }
  | { kind: "terminal"; deliveryId: string; code: string }
  | { kind: "reject"; deliveryId: string; reason: string };

/**
 * Boots a runtime with one Agent whose session reports the native session `native-1`, and hands
 * the test every frame the daemon sends about a delivery. `emit` drives the session's events:
 * any activity makes the Agent busy, `completed` ends its turn.
 */
export async function harness(
  options: {
    reportSession?: boolean;
    refuseNotice?: boolean;
    /** Holds every notice write open until it settles. */
    noticeGate?: Promise<void>;
    /** Holds every launch after the first open until it settles. */
    launchGate?: Promise<void>;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const frames: Frame[] = [];
  const waiters: Array<{ matches: (frame: Frame) => boolean; resolve: () => void }> = [];
  const record = (frame: Frame) => {
    frames.push(frame);
    for (const waiter of waiters.splice(0))
      if (waiter.matches(frame)) waiter.resolve();
      else waiters.push(waiter);
  };
  const notices: string[] = [];
  /** The tracked deliveries each notice carried, as the session was told them. */
  const noticeDeliveryIds: Array<readonly string[] | undefined> = [];
  const noticeWritten = Promise.withResolvers<void>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const exitListeners = new Set<() => void>();
  let launches = 0;
  const launchIds: string[] = [];
  const launchStarted = Promise.withResolvers<void>();
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        launches++;
        if (launches > 1 && options.launchGate) {
          launchStarted.resolve();
          await options.launchGate;
        }
        if (options.reportSession !== false) await sessionOptions.onSessionId?.("native-1");
        return {
          async sendMessage() {
            // Mention delivery starts from a ready Agent, after its startup turn has ended.
            for (const listener of listeners) listener({ type: "completed", status: "completed" });
          },
          async notify(notice: string, noticeOptions?: { deliveryIds?: readonly string[] }) {
            if (options.refuseNotice) throw new Error("the session refused the notice");
            notices.push(notice);
            noticeDeliveryIds.push(noticeOptions?.deliveryIds);
            noticeWritten.resolve();
            await options.noticeGate;
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {},
        } satisfies AgentSession;
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
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          launchIds.push(report.launchId);
        },
        async sendAgentDeliveryAck(ack) {
          record({
            kind: "ack",
            deliveryId: ack.deliveryId,
            ...(ack.mentionDelivery ? { mentionDelivery: ack.mentionDelivery } : {}),
          });
        },
        async sendAgentDeliveryRejection(rejection) {
          record({ kind: "reject", deliveryId: rejection.deliveryId, reason: rejection.reason });
        },
        async sendAgentMentionDeliveryTransition(report) {
          record({
            kind: "transition",
            deliveryId: report.deliveryId,
            stage: report.stage,
            outcome: report.outcome,
          });
        },
        async sendAgentMentionDeliveryTerminalError(report) {
          record({ kind: "terminal", deliveryId: report.deliveryId, code: report.code });
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  const envelope = (
    sequence: number,
    overrides: Partial<MentionDeliveryEnvelope> = {},
  ): MentionDeliveryEnvelope => ({
    messageId: `message-${sequence}`,
    launchId: launchIds.at(-1) ?? "launch-never-reported",
    sessionId: "native-1",
    computerId: connection.computerId,
    ...overrides,
  });
  return {
    runtime,
    frames,
    notices,
    noticeDeliveryIds,
    /** Resolves once the session has been handed its first notice. */
    noticeWritten: noticeWritten.promise,
    /** Resolves once a launch after the first has reached `launchGate`. */
    launchStarted: launchStarted.promise,
    launches: () => launches,
    envelope,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    /** Simulates the Agent's process exiting unexpectedly. */
    exit() {
      for (const listener of exitListeners) listener();
    },
    /** Resolves once the daemon has sent a frame matching `matches` — the observable completion
     * of work the daemon does not hand back to the caller (docs/agents/testing.md). */
    frameSent(matches: (frame: Frame) => boolean): Promise<void> {
      if (frames.some(matches)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ matches, resolve }));
    },
    /** A delivery of message `sequence`; tracked when it carries an envelope. */
    deliver: (sequence: number, mentionDelivery?: MentionDeliveryEnvelope) =>
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
        target: "#general",
        mentionsAgent: true,
        ...(mentionDelivery ? { mentionDelivery } : {}),
      }),
  };
}
