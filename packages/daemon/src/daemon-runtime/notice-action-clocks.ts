import { awakeClockMs } from "#src/platform/awake-clock";
import type { AttentionDecisionOutcome } from "./agent-message-attention-decision-log";

/** Per-Agent clocks for the frozen-after-notice judgment (task #318): when the process last
 * accepted an inbox notice, and when it last did anything a checked read or operation counts
 * as. Provider output's clock lives in `RuntimeProgress`, not here. The judgment reads ages, so
 * each stamp is on the awake clock (a sleeping machine is not a frozen Agent); the notice's
 * wall-clock time is also kept, for ordering it against the turn's start. */
export class NoticeActionClocks {
  readonly #noticeAccepted = new Map<string, { atMs: number; awakeMs: number }>();
  readonly #lastAgentActionAwakeMs = new Map<string, number>();

  constructor(private readonly awakeClock: () => number = awakeClockMs) {}

  /** When the process accepted the notice, as wall time. */
  noticeAcceptedAt(agentId: string): number | undefined {
    return this.#noticeAccepted.get(agentId)?.atMs;
  }

  /** How long ago the process accepted it, in awake time. */
  noticeAcceptedForMs(agentId: string): number | undefined {
    return this.#ageOf(this.#noticeAccepted.get(agentId)?.awakeMs);
  }

  /** How long ago the Agent last acted, in awake time. */
  lastAgentActionForMs(agentId: string): number | undefined {
    return this.#ageOf(this.#lastAgentActionAwakeMs.get(agentId));
  }

  /** The Agent's process accepted an inbox notice: its frozen-after-notice clock starts. */
  noteNoticeAccepted(agentId: string): void {
    this.#noticeAccepted.set(agentId, { atMs: Date.now(), awakeMs: this.awakeClock() });
  }

  /** A checked read or an operation counts as the Agent acting: its frozen-after-notice
   * judgment starts over. */
  noteAgentAction(agentId: string): void {
    this.#lastAgentActionAwakeMs.set(agentId, this.awakeClock());
  }

  #ageOf(awakeMs: number | undefined): number | undefined {
    return awakeMs === undefined ? undefined : this.awakeClock() - awakeMs;
  }
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
