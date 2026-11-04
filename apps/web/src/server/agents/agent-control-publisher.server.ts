import {
  encodeAgentWorkspaceResetRequest,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import { runtimeStartFields } from "./manage-agents.server";
import type { AgentIntroduction } from "./agent-introduction.server";
import type { AgentSessions } from "./agent-sessions.server";
import {
  current,
  type AgentControlAgent,
  type AgentControlRecoveryReader,
  type AgentControlState,
  type AgentControlStore,
  type AgentRecoveryFields,
} from "./agent-control-types.server";

type SubjectSession = { sessionId: string; sessionMode: "create" | "resume" };

/** Sends the Daemon the command a control operation's current phase calls for. */
export class AgentControlPublisher {
  constructor(
    private readonly store: AgentControlStore,
    private readonly api: Pick<CentrifugoServerApi, "publish">,
    private readonly clock: () => number,
    private readonly sessions?: AgentSessions,
    /** Only consulted for a Start that reads the unread messages. */
    private readonly conversations?: AgentControlRecoveryReader,
    /** The introduction prompt a Start carries while the Agent owes its creator one. */
    private readonly introductions?: Pick<AgentIntroduction, "promptFor">,
  ) {}

  /** WeeklyReportAssistant subject launches override the global current session for one start. */
  readonly #subjectSessionByRequest = new Map<string, SubjectSession>();

  /** Runs `launch` with the Start for `requestId` carrying `session` instead of the Agent's current one. */
  async withSubjectSession<T>(
    requestId: string,
    session: SubjectSession,
    launch: () => Promise<T>,
  ): Promise<T> {
    this.#subjectSessionByRequest.set(requestId, session);
    try {
      return await launch();
    } finally {
      this.#subjectSessionByRequest.delete(requestId);
    }
  }

  /** The unread messages a Start surfaces. A failed read never blocks the Start: the Agent still
   * reaches those messages through `check`. */
  async readRecovery(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentRecoveryFields | undefined> {
    if (!this.conversations) return undefined;
    try {
      return await this.conversations.readAgentRecoveryContext(workspaceId, agentId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_control:recovery_read_failed",
          workspace_id: workspaceId,
          agent_id: agentId,
          error_type: errorType(error),
        }),
      );
      return undefined;
    }
  }

  sendStop(state: AgentControlState) {
    return this.api.publish(
      daemonControlChannel(state.workspaceId, state.computerId),
      encodeAgentStopIntent({ ...state, controlEpoch: state.epoch }),
    );
  }
  async publishCurrent(agentId: string, requestId: string, recovery?: AgentRecoveryFields) {
    const agent = await this.store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.requestId !== requestId || !current(agent, state))
      throw new Error("Agent configuration changed");
    await this.publish(agent, state, recovery);
  }
  /** Sends the command for `state`'s phase; `agent` is the record `state` is current for. */
  async publish(
    agent: AgentControlAgent,
    state: AgentControlState,
    recovery?: AgentRecoveryFields,
  ) {
    const agentId = agent.id;
    const { requestId } = state;
    if (state.phase === "stopping") {
      await this.sendStop(state);
    } else if (state.phase === "clearing") {
      await this.api.publish(
        daemonControlChannel(state.workspaceId, state.computerId),
        encodeAgentWorkspaceResetRequest(state),
      );
    } else if (state.phase === "starting" || (state.phase === "completed" && recovery)) {
      // A Restart or Reset ends with a Start after its stop step, which dropped what the daemon
      // held (already acknowledged). That Start carries the unread messages from the read
      // boundary, the same recovery a plain Start reads in `execute`.
      if (!recovery && state.phase === "starting" && state.action !== "start")
        recovery = await this.readRecovery(state.workspaceId, agentId);
      // `launchId` should already be minted (`begin()`/`advance()`, the moment this
      // operation entered "starting"); the only gap is a "starting" row written before this
      // record shipped. Mint and persist it here, once, before publish — never for a "completed"
      // republish, which already has one from when it first started.
      let launchId = state.launchId;
      if (state.phase === "starting" && !launchId) {
        launchId = crypto.randomUUID();
        if (!(await this.store.replace(agent, { ...state, launchId }))) {
          const refreshed = await this.store.get(agentId);
          const refreshedLaunchId =
            refreshed?.state?.requestId === requestId ? refreshed.state.launchId : undefined;
          if (!refreshedLaunchId) throw new Error("Agent launch could not be assigned an id");
          launchId = refreshedLaunchId;
        }
      }
      await this.sendStart(agent, state, launchId, { recovery });
    }
  }
  /** Sends `state`'s Start for `agent`, carrying either message recovery or a resume prompt. */
  async sendStart(
    agent: AgentControlAgent,
    state: AgentControlState,
    launchId: string | undefined,
    first: { recovery?: AgentRecoveryFields; resumePrompt?: string },
  ) {
    const { requestId, identity } = state;
    const reset =
      state.phase !== "completed" &&
      (state.action === "reset-session" || state.action === "full-reset");
    const { recovery, resumePrompt } = first;
    const introductionPrompt = await this.introductions?.promptFor(agent, new Date(this.clock()));
    const intent: AgentStartIntent = {
      protocolMajor: 1,
      requestId,
      workspaceId: state.workspaceId,
      computerId: state.computerId,
      agentId: agent.id,
      ...runtimeStartFields(agent.runtimeConfig),
      controlEpoch: state.epoch,
      ...(launchId ? { launchId } : {}),
      ...(this.#subjectSessionByRequest.get(requestId)
        ? this.#subjectSessionByRequest.get(requestId)
        : !reset &&
            identity?.sessionId &&
            (identity.state !== "empty" || state.phase === "completed")
          ? { sessionId: identity.sessionId }
          : {}),
      ...(recovery
        ? {
            wakeMessage: recovery.wakeMessage,
            resumeMessages: recovery.resumeMessages,
            unreadSummary: recovery.unreadSummary,
            unreadConversationIds: recovery.unreadConversationIds,
          }
        : {}),
      ...(resumePrompt !== undefined ? { resumePrompt } : {}),
      ...(introductionPrompt !== undefined ? { introductionPrompt } : {}),
    };
    const selected = this.sessions ? await this.sessions.prepare(intent) : intent;
    await this.api.publish(
      daemonControlChannel(state.workspaceId, state.computerId),
      encodeAgentStartIntent(selected),
    );
  }
}
