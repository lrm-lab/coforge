import type { AttentionDecisionOutcome } from "./agent-message-attention-index";

/** Per-Agent clocks for the frozen-after-notice judgment (task #318): when the process last
 * accepted an inbox notice, and when it last did anything a checked read or operation counts
 * as. Provider output's clock lives in `RuntimeProgress`, not here. */
export class NoticeActionClocks {
  readonly #noticeAcceptedAt = new Map<string, number>();
  readonly #lastAgentActionAt = new Map<string, number>();

  noticeAcceptedAt(agentId: string): number | undefined {
    return this.#noticeAcceptedAt.get(agentId);
  }

  lastAgentActionAt(agentId: string): number | undefined {
    return this.#lastAgentActionAt.get(agentId);
  }

  /** The Agent's process accepted an inbox notice: its frozen-after-notice clock starts. */
  noteNoticeAccepted(agentId: string): void {
    this.#noticeAcceptedAt.set(agentId, Date.now());
  }

  /** A checked read or an operation counts as the Agent acting: its frozen-after-notice
   * judgment starts over. */
  noteAgentAction(agentId: string): void {
    this.#lastAgentActionAt.set(agentId, Date.now());
  }
}

/** The frozen-after-notice ports `RuntimeRelease.stalled` reads, bound to the attention index
 * that owns the clocks. */
export function noticeActionClockPorts(
  clocks: () => NoticeActionClocks,
): Readonly<{
  noticeAcceptedAt(agentId: string): number | undefined;
  lastAgentActionAt(agentId: string): number | undefined;
}> {
  return {
    noticeAcceptedAt: (agentId) => clocks().noticeAcceptedAt(agentId),
    lastAgentActionAt: (agentId) => clocks().lastAgentActionAt(agentId),
  };
}

/** `authorizedAgent` wrapped so every forwarded request also stamps the Agent's action clock:
 * a working Agent is never judged frozen. */
export function actionStampingAuthorizedAgent(
  authorizedAgent: (context: string, agentApiKey: string | undefined) => string,
  clocks: { noteAgentAction(agentId: string): void },
): (context: string, agentApiKey: string | undefined) => string {
  return (context, agentApiKey) => {
    const agentId = authorizedAgent(context, agentApiKey);
    clocks.noteAgentAction(agentId);
    return agentId;
  };
}

/** The release-facts ports `RuntimeRelease.stalled` reads that are not the notice clocks:
 * restart capability, the reported session, a stop in flight, and the delivery queue's wait. */
export function releaseFactPorts(input: {
  runningMentionIdentity(agentId: string): unknown;
  sessionId(agentId: string): string | undefined;
  stopping(agentId: string): boolean;
  queuedForMs(agentId: string): number | undefined;
}): Readonly<{
  resumable(agentId: string): boolean;
  sessionId(agentId: string): string | undefined;
  isStopping(agentId: string): boolean;
  queuedForMs(agentId: string): number | undefined;
}> {
  return {
    resumable: (agentId) => input.runningMentionIdentity(agentId) !== undefined,
    sessionId: input.sessionId,
    isStopping: input.stopping,
    queuedForMs: input.queuedForMs,
  };
}

/** The attention-and-custody ports `AgentExitedDelivery`'s message bookkeeping reads, from one
 * input so `runtime.ts` assembles them in a call, not a list. */
export function exitedDeliveryAttentionPorts<Message>(input: {
  receive(message: Message): Promise<void>;
  hasConsumed(message: Message): boolean;
  logDecision(message: Message, decision: AttentionDecisionOutcome): void;
  acknowledge(message: Message): Promise<void>;
  acknowledgeCustody(message: Message): void;
}): Readonly<{
  holdRuntimeErrorDelivery(message: Message): Promise<void>;
  hasConsumed(message: Message): boolean;
  logConsumed(message: Message): void;
  acknowledge(message: Message): Promise<void>;
  acknowledgeCustody(message: Message): void;
}> {
  return {
    holdRuntimeErrorDelivery: input.receive,
    hasConsumed: input.hasConsumed,
    logConsumed: (message) => input.logDecision(message, "consumed"),
    acknowledge: input.acknowledge,
    acknowledgeCustody: input.acknowledgeCustody,
  };
}
