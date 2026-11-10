import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentActivity,
  AgentWorkspaceDeleteRequest,
  MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
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
    /** The provider's session creations (1 is the first launch) that fail instead. */
    failSessions?: readonly number[];
    /** Holds every session creation after the first open until the gate settles. */
    createGate?: Promise<void>;
    /** Holds the first session's second notice open past its own end, then fails it: a notice
     * that settles after the Agent's next launch is registered. */
    lateFailure?: Promise<void>;
  } = {},
) {
  let disposeFailures = options.disposeFailures ?? 0;
  /** Settles when the first session's `dispose` has begun. */
  const disposing = Promise.withResolvers<void>();
  /** Settles when a later launch has reached its held session creation. */
  const creating = Promise.withResolvers<void>();
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Recorded[] = [];
  const activities: AgentActivity[] = [];
  const invalidates: Array<Record<string, unknown>> = [];
  /** The codes of the terminal errors the daemon reported for tracked mentions. */
  const terminalErrors: string[] = [];
  /** The ACKs the daemon sent, with the envelope a tracked mention's one echoes. */
  const acks: Array<{ deliveryId: string; mentionDelivery?: MentionDeliveryEnvelope }> = [];
  /** The tracked-mention transitions the daemon reported. */
  const transitions: Array<{ deliveryId: string; stage: string; outcome: string }> = [];
  /** The launch and native session the daemon last reported for the Agent. */
  let reported: { launchId: string; sessionId: string } | undefined;
  let creations = 0;
  let deleteWorkspace: ((request: AgentWorkspaceDeleteRequest) => Promise<void>) | undefined;
  /** While set, every notice a session is handed waits for it after being recorded. */
  let noticeGate: Promise<void> | undefined;
  /** Whether the sessions report a turn in progress. */
  let liveTurn = false;
  /** While set, every notice a session is handed is refused. */
  let refuseNotices = false;
  let answerBeforeRefusing = false;
  /** Only notices containing this are refused. */
  let refuseOnly = "";
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        creations += 1;
        if (creations > 1 && options.createGate) {
          creating.resolve();
          await options.createGate;
        }
        if (options.failSessions?.includes(creations))
          throw new Error("the provider would not start");
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exitListeners = new Set<() => void>();
        const ended = Promise.withResolvers<void>();
        let notifies = 0;
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
            if (options.lateFailure && sessions.length === 1 && (notifies += 1) === 2) {
              await options.lateFailure;
              throw new Error("the ended session failed the notice late");
            }
            // A gated notice is rejected when its session ends first, as a provider does.
            if (noticeGate) await Promise.race([noticeGate, ended.promise]);
            if (record.disposed) throw new Error("the session ended before accepting the notice");
            if (refuseNotices && notice.includes(refuseOnly)) {
              // The model may have answered by the time the session refuses the notice.
              if (answerBeforeRefusing) record.emit({ type: "text-delta", text: "On it." });
              throw new Error("the session refused the notice");
            }
          },
          get hasLiveTurn() {
            return liveTurn;
          },
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
            ended.resolve();
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
        async reportAgentSession(report) {
          reported = { launchId: report.launchId, sessionId: report.sessionId };
        },
        async sendAgentDeliveryAck(ack) {
          acks.push({
            deliveryId: ack.deliveryId,
            ...(ack.mentionDelivery ? { mentionDelivery: ack.mentionDelivery } : {}),
          });
        },
        async sendAgentDeliveryRejection() {},
        onWorkspaceDelete(handler) {
          deleteWorkspace = handler;
          return () => {};
        },
        async sendAgentMentionDeliveryTransition(report) {
          transitions.push({
            deliveryId: report.deliveryId,
            stage: report.stage,
            outcome: report.outcome,
          });
        },
        async sendAgentMentionDeliveryTerminalError(report) {
          terminalErrors.push(report.code);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    join(connection.workspaceRoot, `state-${crypto.randomUUID()}`),
  );
  await runtime.start(connection);
  /** The control epoch of the latest server intent for the Agent. */
  let epoch = 0;
  /** A server Start of the Agent; the first one carries the harness options. */
  const start = (extra: Record<string, unknown> = {}) => {
    epoch += 1;
    return runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: `start-${epoch}`,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...config,
      ...(epoch === 1 && options.resume ? { sessionId: options.resume } : {}),
      ...(epoch === 1 && options.sessionMode ? { sessionMode: options.sessionMode } : {}),
      ...(epoch === 1 ? options.start : {}),
      ...extra,
      controlEpoch: epoch,
      launchId: `launch-${epoch}`,
    });
  };
  /** A server Stop of the Agent: a person's, as opposed to the cleanup after a failed launch. */
  const stop = () => {
    epoch += 1;
    return runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: `stop-${epoch}`,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: config.provider,
      controlEpoch: epoch,
    });
  };
  await start();
  /** A delivery of message `sequence`; tracked when it carries an envelope. */
  const deliver = (
    sequence: number,
    mentionDelivery?: MentionDeliveryEnvelope,
    target = "#general",
  ) =>
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
      target,
      mentionsAgent: true,
      ...(mentionDelivery ? { mentionDelivery } : {}),
    });
  /** The envelope of a tracked mention of message `sequence`, issued for the first launch. */
  const envelope = (sequence: number, sessionId: string): MentionDeliveryEnvelope => ({
    messageId: `message-${sequence}`,
    launchId: "launch-1",
    sessionId,
    computerId: connection.computerId,
  });
  /** The envelope the server issues again for message `sequence`, for the launch and session the
   * daemon last reported: the same delivery, a new envelope. */
  const reissue = (sequence: number): MentionDeliveryEnvelope => ({
    messageId: `message-${sequence}`,
    launchId: reported!.launchId,
    sessionId: reported!.sessionId,
    computerId: connection.computerId,
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
    terminalErrors,
    acks,
    transitions,
    reissue,
    start,
    stop,
    /** The server deletes the Agent's workspace, as the Agent API would. */
    deleteAgent: () =>
      deleteWorkspace?.({
        protocolMajor: 1,
        requestId: "delete-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
      }),
    envelope,
    deliver,
    /** Holds every notice a session is handed (after it is recorded) until the returned release. */
    gateNotices() {
      const gate = Promise.withResolvers<void>();
      noticeGate = gate.promise;
      return () => {
        noticeGate = undefined;
        gate.resolve();
      };
    },
    /** Makes every session report, or stop reporting, a turn in progress. */
    liveTurn(live: boolean) {
      liveTurn = live;
    },
    /** Makes every session refuse the notices it is handed from now on. */
    refuseNotices(refuse: boolean, answerFirst = false, only = "") {
      refuseNotices = refuse;
      refuseOnly = only;
      answerBeforeRefusing = answerFirst;
    },
    failTurn,
    until,
    disposing: disposing.promise,
    creating: creating.promise,
  };
}
