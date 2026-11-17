import { awakeClockMs } from "#src/platform/awake-clock";

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
