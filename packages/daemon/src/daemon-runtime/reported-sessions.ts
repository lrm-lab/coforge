import type { RunningMentionIdentity } from "./mention-delivery-ports";

/** The launch and native session each Agent's latest session report named: what a tracked
 * mention's envelope must name to be told to it, or to be kept for the launch that follows. */
export class ReportedSessions {
  readonly #byAgent = new Map<string, RunningMentionIdentity>();

  /** The thunks read the process manager and launches the runtime builds after this field. */
  constructor(
    private readonly agents: () => { session(agentId: string): unknown },
    private readonly currentLaunches: () => ReadonlyMap<string, { launchId?: string }>,
  ) {}

  /** What tracked mentions are judged against: the latest reported pair when `reported`, else the
   * pair of a running Agent. */
  identity(agentId: string, reported?: true): RunningMentionIdentity | undefined {
    return reported
      ? this.last(agentId)
      : this.running(agentId, this.agents(), this.currentLaunches());
  }

  remember({ agentId, launchId, sessionId }: RunningMentionIdentity & { agentId: string }): void {
    this.#byAgent.set(agentId, { launchId, sessionId });
  }

  /** The Agent's latest reported pair, whether or not a process runs. */
  last(agentId: string): RunningMentionIdentity | undefined {
    return this.#byAgent.get(agentId);
  }

  /** The pair a running Agent may receive tracked mentions for: only while its process is up and
   * its reported session still matches the launch currently being observed. */
  running(
    agentId: string,
    agents: { session(agentId: string): unknown },
    currentLaunches: ReadonlyMap<string, { launchId?: string }>,
  ): RunningMentionIdentity | undefined {
    if (!agents.session(agentId)) return undefined;
    const reported = this.#byAgent.get(agentId);
    return reported && currentLaunches.get(agentId)?.launchId === reported.launchId
      ? reported
      : undefined;
  }
}
