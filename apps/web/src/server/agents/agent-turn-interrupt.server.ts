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

/** What starting an interrupt tells the page: the request whose outcome `read` returns, or why
 * nothing was asked of the Computer. */
export type AgentTurnInterruptStart =
  | { status: "started"; requestId: string }
  | { status: "refused"; reason: "not_running" | "offline" | "needs_upgrade" };

/** What reading a request tells the page: no outcome yet, or the Computer's. */
export type AgentTurnInterruptRead =
  | { status: "pending" }
  | { status: "settled"; outcome: AgentTurnInterruptResult["status"] };

type Caller = { userId: string; workspaceId: string; agentId: string };

/**
 * The non-durable request/response seam behind the Agent detail page's Stop current turn action.
 * The Computer can take about fifteen seconds and production closes a request idle for about ten,
 * so `start` publishes the interrupt and returns at once, and the page polls `read` for the
 * Daemon's answer.
 */
export class AgentTurnInterrupt {
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
  ) {}

  /** Throws unless the caller may control this Agent's runtime; returns the Agent. */
  async #authorize(input: Caller) {
    const role = await this.store.memberRole(input.workspaceId, input.userId);
    if (!role) throw new Error("Agent is not authorized or assigned");
    assertHasAgentControlCapability(role as WorkspaceMemberRole, "controlAgentRuntime");
    const agent = await this.store.get(input.agentId);
    if (!agent || agent.workspaceId !== input.workspaceId)
      throw new Error("Agent is not authorized or assigned");
    assertAgentLive(agent);
    if (!canSeeAgent({ kind: "user", userId: input.userId, role }, agent))
      throw new Error("Agent is not authorized or assigned");
    return agent;
  }

  async start(input: Caller): Promise<AgentTurnInterruptStart> {
    const prepared = await this.runtimeLock.run(input.agentId, async () => {
      const agent = await this.#authorize(input);
      const computerId = agent.computerId;
      const state = agent.state;
      if (!computerId || !state?.launchId || state.action === "stop") return undefined;
      const intent: AgentTurnInterruptIntent = {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        computerId,
        agentId: input.agentId,
        provider: state.provider,
        epoch: state.epoch,
        launchId: state.launchId,
      };
      return { intent, computerId };
    });
    if (!prepared) return { status: "refused", reason: "not_running" };
    const { intent, computerId } = prepared;
    if (!(await this.computerStatus.get({ workspaceId: input.workspaceId, computerId })))
      return { status: "refused", reason: "offline" };
    if (!(await this.capability.supports(input.workspaceId, computerId)))
      return { status: "refused", reason: "needs_upgrade" };
    try {
      await this.api.publish(
        daemonControlChannel(input.workspaceId, computerId),
        encodeAgentTurnInterruptIntent(intent),
      );
    } catch {
      return { status: "refused", reason: "offline" };
    }
    return { status: "started", requestId: intent.requestId };
  }

  /**
   * The Computer's outcome of one request, for a caller who may still control the Agent: the
   * access is checked again on every read. The stored result is looked up under the caller's
   * Workspace and Agent, so a request id reads nothing of another's. The result is left to expire,
   * so a page that lost the reply can ask again.
   */
  async read(input: Caller & { requestId: string }): Promise<AgentTurnInterruptRead> {
    await this.#authorize(input);
    const result = await this.results.read({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      requestId: input.requestId,
    });
    return result ? { status: "settled", outcome: result.status } : { status: "pending" };
  }

  /**
   * Stores a daemon's result for the page polling for it, which may reach another instance. The
   * entry point checks the Agent runs on the reporting Computer, in the launch the result names,
   * before anything is written: the first result stored for a request wins, so a result from a
   * Computer that does not run the Agent, or from an earlier launch, must never get that far.
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
