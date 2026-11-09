import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";

export const connection: WorkspaceConfig = {
  computerId: "computer-replay",
  workspaceId: "workspace-replay",
  workspaceRoot: join(realpathSync(tmpdir()), `coforge-replay-recovery-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

export const REJECTED: Extract<AgentRuntimeEvent, { type: "error" }> = {
  type: "error",
  message: "Encrypted content could not be decrypted or parsed.",
  providerErrorClass: "invalid_encrypted_content",
  providerErrorReason: "turn_failed",
  sessionRecovery: "provider_replay_rejected",
};
export const FAILED_TURN: AgentRuntimeEvent = { type: "completed", status: "failed" };

export type Recorded = {
  options: AgentSessionOptions;
  /** Every notice the session was handed. */
  notices: string[];
  disposed: boolean;
  emit(event: AgentRuntimeEvent): void;
};

/** One managed Agent on a fake provider whose sessions can be driven, ended and counted. */
export async function harness(
  options: {
    /** The stored session the first launch resumes; none starts a fresh one. */
    resume?: string;
    /** Holds every `dispose` open until the gate settles. */
    disposeGate?: Promise<void>;
    /** How many `dispose` calls fail before one succeeds. */
    disposeFailures?: number;
    /** How the first launch treats `resume`. */
    sessionMode?: "create" | "resume";
    /** What the Start carries beyond its session: recovery, resume or introduction prompt. */
    start?: Record<string, unknown>;
    /** The id every session reports as its own, whatever was asked for. */
    reportAs?: string;
  } = {},
) {
  let disposeFailures = options.disposeFailures ?? 0;
  /** Settles when the first session's `dispose` has begun. */
  const disposing = Promise.withResolvers<void>();
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Recorded[] = [];
  const activities: AgentActivity[] = [];
  const invalidates: Array<Record<string, unknown>> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exitListeners = new Set<() => void>();
        const record: Recorded = {
          options: sessionOptions,
          notices: [],
          disposed: false,
          emit(event) {
            for (const listener of listeners) listener(event);
          },
        };
        sessions.push(record);
        // A resumed session keeps its id; a fresh one gets a new one.
        const nativeId =
          options.reportAs ?? sessionOptions.sessionId ?? `native-${sessions.length}`;
        await sessionOptions.onSessionId?.(nativeId);
        return {
          async sendMessage(text: string) {
            record.notices.push(text);
          },
          async notify(notice: string) {
            record.notices.push(notice);
          },
          hasLiveTurn: false,
          steersBusyTurn: true,
          readSessionIdentity: async () => ({
            sessionId: nativeId,
            state: "resumable" as const,
          }),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {
            disposing.resolve();
            await options.disposeGate;
            if (disposeFailures > 0) {
              disposeFailures -= 1;
              throw new Error("the process would not exit");
            }
            record.disposed = true;
            for (const listener of Array.from(exitListeners)) listener();
          },
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
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendSessionInvalidate(message: Record<string, unknown>) {
          invalidates.push(message);
        },
        async sendAgentControlResult() {},
        async reportAgentSession() {},
        async sendAgentDeliveryAck() {},
        async sendAgentDeliveryRejection() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  await runtime.handleAgentStart({
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    ...(options.resume ? { sessionId: options.resume } : {}),
    ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
    ...options.start,
    controlEpoch: 1,
    launchId: "launch-1",
  });
  const deliver = (sequence: number) =>
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
    });
  /** A turn that fails the way a rejected replay does. */
  const failTurn = (session: Recorded, event: AgentRuntimeEvent = REJECTED) => {
    session.emit(event);
    session.emit(FAILED_TURN);
  };
  /** Waits for a condition the daemon reaches on its own. */
  const until = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 400 && !done(); attempt += 1) await Bun.sleep(5);
    if (!done()) throw new Error("timed out waiting for the daemon");
  };
  return {
    runtime,
    sessions,
    activities,
    invalidates,
    deliver,
    failTurn,
    until,
    disposing: disposing.promise,
  };
}
