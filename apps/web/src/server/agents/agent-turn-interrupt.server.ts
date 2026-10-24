import {
  AGENT_TURN_INTERRUPT_METHOD,
  encodeAgentTurnInterruptIntent,
  type AgentTurnInterruptIntent,
  type AgentTurnInterruptResult,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
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

type Waiter = {
  intent: AgentTurnInterruptIntent;
  resolve: (result: AgentTurnInterruptResult | "timeout") => void;
  timer: ReturnType<typeof setTimeout>;
};

const RESULT_TIMEOUT_MS = 20_000;

/** The non-durable request/response seam behind the Agent detail page's Stop current turn action. */
export class AgentTurnInterrupt {
  readonly #waiters = new Map<string, Waiter>();

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

    const result = this.#wait(prepared.intent);
    try {
      await this.api.publish(
        daemonControlChannel(input.workspaceId, prepared.computerId),
        encodeAgentTurnInterruptIntent(prepared.intent),
      );
    } catch {
      this.#finish(prepared.intent.requestId);
      return "offline";
    }
    const settled = await result;
    return settled === "timeout" ? "failed" : settled.status;
  }

  receive(
    scope: { workspaceId: string; computerId: string },
    result: AgentTurnInterruptResult,
  ): boolean {
    const waiter = this.#waiters.get(result.requestId);
    if (
      !waiter ||
      waiter.intent.workspaceId !== scope.workspaceId ||
      waiter.intent.computerId !== scope.computerId
    )
      return false;
    if (
      waiter.intent.agentId !== result.agentId ||
      waiter.intent.epoch !== result.epoch ||
      waiter.intent.launchId !== result.launchId
    )
      return false;
    this.#finish(result.requestId);
    waiter.resolve(result);
    return true;
  }

  #wait(intent: AgentTurnInterruptIntent): Promise<AgentTurnInterruptResult | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiter = this.#waiters.get(intent.requestId);
        if (!waiter) return;
        this.#waiters.delete(intent.requestId);
        waiter.resolve("timeout");
      }, this.timeoutMs);
      this.#waiters.set(intent.requestId, { intent, resolve, timer });
    });
  }

  #finish(requestId: string): void {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#waiters.delete(requestId);
  }
}

export { AGENT_TURN_INTERRUPT_METHOD };
