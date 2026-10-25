import {
  AGENT_TURN_INTERRUPT_METHOD,
  encodeAgentTurnInterruptIntent,
  type AgentTurnInterruptIntent,
  type AgentTurnInterruptResult,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import type { AgentTurnInterruptResults } from "./agent-turn-interrupt-results.server";
import type { AgentControlStore } from "./agent-control.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { assertAgentLive } from "./active-agent.server";
import { canSeeAgent } from "./agent-visibility.server";
import {
  assertHasAgentControlCapability,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

export type AgentTurnInterruptOutcome =
  | AgentTurnInterruptResult["status"]
  | "offline"
  | "needs_upgrade"
  | "failed";

const RESULT_TIMEOUT_MS = 20_000;

/** The non-durable request/response seam behind the Agent detail page's Stop current turn action. */
export class AgentTurnInterrupt {
  /** Request ids this instance is waiting on; the results themselves go through `results`. */
  readonly #pending = new Set<string>();

  constructor(
    private readonly store: Pick<AgentControlStore, "get" | "memberRole">,
    private readonly api: Pick<CentrifugoServerApi, "publish">,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly computerStatus: {
      get(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
    },
    private readonly capability: {
      supports(workspaceId: string, computerId: string): Promise<boolean>;
    },
    private readonly results: AgentTurnInterruptResults,
    private readonly timeoutMs = RESULT_TIMEOUT_MS,
  ) {}

  async interrupt(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    requestId: string;
  }): Promise<AgentTurnInterruptOutcome> {
    const prepared = await this.runtimeLock.run(input.agentId, async () => {
      const role = await this.store.memberRole(input.workspaceId, input.userId);
      if (!role) throw new Error("Agent is not authorized or assigned");
      assertHasAgentControlCapability(role as WorkspaceMemberRole, "controlAgentRuntime");
      const agent = await this.store.get(input.agentId);
      if (!agent || agent.workspaceId !== input.workspaceId)
        throw new Error("Agent is not authorized or assigned");
      assertAgentLive(agent);
      if (!canSeeAgent({ kind: "user", userId: input.userId, role }, agent))
        throw new Error("Agent is not authorized or assigned");
      const computerId = agent.computerId;
      const state = agent.state;
      if (!computerId || !state?.launchId || state.action === "stop") return undefined;
      const intent: AgentTurnInterruptIntent = {
        protocolMajor: 1,
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        computerId,
        agentId: input.agentId,
        provider: state.provider,
        epoch: state.epoch,
        launchId: state.launchId,
      };
      return { intent, computerId };
    });
    if (!prepared) return "not_running";
    if (
      !(await this.computerStatus.get({
        workspaceId: input.workspaceId,
        computerId: prepared.computerId,
      }))
    )
      return "offline";
    if (!(await this.capability.supports(input.workspaceId, prepared.computerId)))
      return "needs_upgrade";

    // A retried or squatted request id must not share the wait of the one already holding it.
    const { intent } = prepared;
    if (this.#pending.has(intent.requestId)) return "failed";
    this.#pending.add(intent.requestId);
    try {
      await this.api.publish(
        daemonControlChannel(input.workspaceId, prepared.computerId),
        encodeAgentTurnInterruptIntent(intent),
      );
    } catch {
      this.#pending.delete(intent.requestId);
      return "offline";
    }
    try {
      // Publishing first is safe: `wait` reads the stored result after it subscribes.
      const settled = await this.results.wait(
        {
          workspaceId: intent.workspaceId,
          agentId: intent.agentId,
          requestId: intent.requestId,
        },
        this.timeoutMs,
        (result) =>
          intent.agentId === result.agentId &&
          intent.epoch === result.epoch &&
          intent.launchId === result.launchId,
      );
      return settled === "timeout" ? "failed" : settled.status;
    } catch {
      return "failed";
    } finally {
      this.#pending.delete(intent.requestId);
    }
  }

  /**
   * Stores a daemon's result for the instance waiting on it, which may be another one. The entry
   * point checks the Agent runs on the reporting Computer, in the launch the result names, before
   * anything is written: the first result stored for a request wins, so a result from a Computer
   * that does not run the Agent, or from an earlier launch, must never get that far.
   */
  async receive(
    scope: { workspaceId: string; computerId: string },
    result: AgentTurnInterruptResult,
  ): Promise<boolean> {
    const agent = await this.store.get(result.agentId);
    if (
      !agent ||
      agent.workspaceId !== scope.workspaceId ||
      agent.computerId !== scope.computerId ||
      agent.state?.launchId !== result.launchId ||
      agent.state.epoch !== result.epoch
    )
      return false;
    await this.results.put(
      { workspaceId: scope.workspaceId, agentId: result.agentId, requestId: result.requestId },
      result,
    );
    return true;
  }
}

export { AGENT_TURN_INTERRUPT_METHOD };
