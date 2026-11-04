import type { AgentControlResult, AgentStartIntent } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { assertAgentLive } from "./active-agent.server";
import { AppError } from "#src/lib/app-error";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type { AgentSessions } from "./agent-sessions.server";
import type { AgentIntroduction } from "./agent-introduction.server";
import { LocalAgentControlSignal, type AgentControlSignal } from "./agent-control-signal.server";
import { AgentControlAccess } from "./agent-control-access.server";
import { AgentControlDriver } from "./agent-control-driver.server";
import { AgentControlBatch } from "./agent-control-batch.server";
import { AgentControlOperations } from "./agent-control-operations.server";
import { AgentControlPublisher } from "./agent-control-publisher.server";
import { AgentControlReceiver, type AgentLaunchClaim } from "./agent-control-receiver.server";

export * from "./agent-control-types.server";

import {
  type AgentControlRecoveryReader,
  type AgentControlAction,
  carriesRecovery,
  current,
  terminal,
  type AgentControlState,
  type AgentControlAgent,
  type AgentControlMentions,
  type AgentControlStore,
  type AgentControlView,
  authorizedAgent,
} from "./agent-control-types.server";

/** One current control operation on the Agent record, not a durable command queue. */
export class AgentControl {
  readonly #access: AgentControlAccess;
  readonly #operations: AgentControlOperations;
  readonly #publisher: AgentControlPublisher;
  readonly #driver: AgentControlDriver;
  readonly #receiver: AgentControlReceiver;
  readonly #batch: AgentControlBatch;

  constructor(
    private readonly store: AgentControlStore,
    api: Pick<CentrifugoServerApi, "publish">,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly timing: {
      timeoutMs: number;
      fallbackMs?: number;
      /** Injected so `execute()`'s `stoppedAt` timestamp and a Start's introduction window are
       * deterministic in tests; defaults to the real clock. No longer drives any
       * abandonment/pending decision — that concept was removed entirely. */
      now?: () => number;
    } = { timeoutMs: 7_000 },
    sessions?: AgentSessions,
    private readonly signal: AgentControlSignal = new LocalAgentControlSignal(),
    /** Only consulted for a user-initiated `execute({action:"start"})`; Restart/Reset/Full reset
     * and the internal `recover`/`publishStart` paths are unchanged. */
    conversations?: AgentControlRecoveryReader,
    /** Settles the tracked mentions a person's Stop leaves undelivered, and issues them again for
     * a launch that started with its session. */
    mentions?: AgentControlMentions,
    /** The introduction prompt a Start carries while the Agent owes its creator one. */
    introductions?: Pick<AgentIntroduction, "promptFor">,
  ) {
    const clock = () => this.clock();
    this.#access = new AgentControlAccess(store);
    this.#operations = new AgentControlOperations(store, this.#access, mentions);
    this.#publisher = new AgentControlPublisher(
      store,
      api,
      clock,
      sessions,
      conversations,
      introductions,
    );
    this.#driver = new AgentControlDriver(store, this.#publisher, signal, timing);
    this.#receiver = new AgentControlReceiver(store, signal, this.#driver, mentions);
    this.#batch = new AgentControlBatch(
      runtimeLock,
      this.#access,
      this.#operations,
      this.#publisher,
      clock,
    );
  }

  private clock(): number {
    return (this.timing.now ?? Date.now)();
  }

  /**
   * Ready recovery republishes the current fence; it never waits for buffered daemon ACKs.
   *
   * A non-terminal state is deliberately republished here, never superseded: `recover` only
   * runs for an Agent the Daemon just reported as NOT running, so there is no risk of a
   * duplicate live process, and the Daemon's own control record repair now answers a
   * request it previously rejected outright instead of leaving it unanswered forever. Minting a
   * fresh epoch on every reconnect would instead churn the request — and republish a brand new
   * Start — on every single `ready()` for an Agent whose Daemon keeps reconnecting without ever
   * answering, without the Daemon ever getting a chance to answer the one it already has.
   * `begin` supersedes on any *owner-initiated* retry through
   * `execute`/`publishStart`/`publishStop`, unconditionally — `recover` is the one path that
   * still only republishes.
   *
   * `loaded` is the Agent the caller already read under this Agent's runtime lock; it is
   * authorized in memory instead of being read again. Nothing can move the control fence between
   * that read, `begin`'s compare-and-swap and the publish: every other writer that could (user
   * control, configuration, deletion) takes the same lock, and Session reports and control
   * results are fenced by a request the Daemon has not been sent yet. Without it, the Agent is
   * read here.
   */
  async recover(intent: AgentStartIntent, userId: string, loaded?: AgentControlAgent) {
    const agent = loaded
      ? authorizedAgent(loaded, userId, intent.workspaceId, intent.agentId)
      : await this.#access.authorized(userId, intent.workspaceId, intent.agentId);
    // Recovery never starts a deleted Agent. `WorkspaceAgentRecovery` already lists
    // deleted Agents separately and stops them instead, so this is the last line of defence for a
    // Daemon `ready` that races a delete.
    assertAgentLive(agent);
    // The migration starts it itself once it has moved, or once the attempt has ended.
    if (agent.migrating) return;
    if (agent.state && !terminal(agent.state)) {
      await this.#driver.advance(agent.id, agent.state.requestId, intent);
      return;
    }
    const state = await this.#operations.begin(agent, "start", intent.requestId);
    // `begin` built `state` from `agent` (a retry only after checking the Computer and
    // configuration it publishes did not change), so it is published without reading it back.
    await this.#publisher.publish(agent, state, intent);
  }
  /** Clears a terminal launch failure on an Agent using CAS and notifying subscribers. */
  async clearLaunchFailure(agentId: string, expectedErrorCode?: string): Promise<boolean> {
    const agent = await this.store.get(agentId);
    if (!agent || !agent.state || agent.state.phase !== "failed") return false;
    if (expectedErrorCode && agent.state.errorCode !== expectedErrorCode) return false;
    const { errorCode: _err, failedAtMs: _failedAt, ...fields } = agent.state;
    const next: AgentControlState = {
      ...fields,
      controlSequence: agent.state.controlSequence + 1,
      phase: "completed",
    };
    if (!(await this.store.replace(agent, next))) return false;
    await this.signal.notify(agent.id).catch(() => {});
    return true;
  }
  async execute(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    requestId: string;
    action: AgentControlAction;
    confirmed?: boolean;
  }): Promise<AgentControlView> {
    if (input.action === "full-reset" && input.confirmed !== true)
      throw new Error("Full reset confirmation is required");
    // `stop` persists the user's stop intent before the chain runs at all, so it
    // survives even if the Computer never answers; every other action clears it first. Messages
    // that arrived while stopped are surfaced for the explicit "start" action here, and for the
    // Start that ends a Restart or Reset in `publishCurrent`: the same recovery context a
    // Daemon-ready recovery start carries.
    const stoppedAt = input.action === "stop" ? new Date(this.clock()) : null;
    const recovery =
      input.action === "start"
        ? await this.#publisher.readRecovery(input.workspaceId, input.agentId)
        : undefined;
    let drivenRequestId = input.requestId;
    await this.runtimeLock.run(input.agentId, async () => {
      const agent = await this.#access.authorizedForExecute(
        input.userId,
        input.workspaceId,
        input.agentId,
        input.action,
      );
      if (input.action !== "stop" && agent.migrating)
        throw new AppError("CONFLICT", { errorId: "agent-migrating" });
      // A Start that meets an Agent already starting joins that launch, it never issues
      // a second one. Superseding here would publish Start at epoch + 1 while the Daemon is
      // still launching the previous epoch; the Daemon answers that with `agent_already_running`
      // and no result, and the running launch's own `started` result and Session snapshots are
      // then stale, so the server would never learn the new Session.
      const inFlight = agent.state;
      if (
        input.action === "start" &&
        inFlight &&
        inFlight.phase === "starting" &&
        current(agent, inFlight) &&
        !agent.stoppedAt
      ) {
        drivenRequestId = inFlight.requestId;
        return;
      }
      await this.#operations.begin(agent, input.action, input.requestId, 1, stoppedAt);
    });
    return this.#driver.drive(input.agentId, drivenRequestId, recovery);
  }
  stopMany(input: Parameters<AgentControlBatch["stopMany"]>[0]) {
    return this.#batch.stopMany(input);
  }
  startMany(input: Parameters<AgentControlBatch["startMany"]>[0]) {
    return this.#batch.startMany(input);
  }

  /** Caller already holds the existing Agent runtime lock (create/update/recovery). */
  async publishStart(intent: AgentStartIntent, userId: string): Promise<void> {
    const agent = await this.#access.authorized(userId, intent.workspaceId, intent.agentId);
    // A deleted Agent is never started again. Every configuration, credential and
    // environment mutation funnels its restart through here, so this is the one place that has to
    // hold; `execute()` refuses it earlier, with a user-facing message.
    assertAgentLive(agent);
    if (agent.migrating) throw new AppError("CONFLICT", { errorId: "agent-migrating" });
    let state = agent.state;
    let began = false;
    if (state && !terminal(state)) {
      // A Start already in flight for the same purpose (recovery, another config-triggered
      // publishStart) continues rather than restarting the launch from scratch; anything else —
      // a Stop, Restart, Reset session or Full reset still in flight — is an explicit command
      // superseding another explicit command, so it always supersedes; `begin`
      // no longer throws "pending" for this.
      if (state.action !== "start") {
        state = await this.#operations.begin(agent, "start", intent.requestId);
        began = true;
      }
    } else if (!state || state.phase === "failed" || state.action === "stop") {
      state = await this.#operations.begin(agent, "start", intent.requestId);
      began = true;
    }
    // A configuration restart stopped the Agent first, dropping what its daemon held (already
    // acknowledged), so a fresh Start that brings no recovery of its own reads the unread
    // messages, as a plain Start does. A Daemon-ready recovery Start already carries them.
    const recovery =
      began && !carriesRecovery(intent)
        ? { ...intent, ...(await this.#publisher.readRecovery(intent.workspaceId, intent.agentId)) }
        : intent;
    await this.#publisher.publishCurrent(agent.id, state.requestId, recovery);
  }

  /** Config/credential changes must confirm stop before mutating configuration. */
  async publishStop(
    input: { agentId: string; workspaceId: string; requestId: string },
    userId: string,
  ) {
    const agent = await this.#access.authorized(userId, input.workspaceId, input.agentId);
    const state = await this.#operations.begin(agent, "stop", input.requestId);
    const result = await this.#driver.drive(agent.id, state.requestId);
    if (result.phase !== "completed")
      throw new Error(
        result.phase === "superseded"
          ? "Agent stop was superseded by a newer command before it completed"
          : "Agent stop has not completed",
      );
  }

  /** Native session and control phase used to decide a WeeklyReportAssistant subject switch. */
  async readLaunchPresence(input: { userId: string; workspaceId: string; agentId: string }) {
    const agent = await this.#access.authorized(input.userId, input.workspaceId, input.agentId);
    return {
      phase: agent.state?.phase ?? null,
      action: agent.state?.action ?? null,
      sessionId: agent.identity?.sessionId ?? null,
      stoppedByUser: Boolean(agent.stoppedAt),
    };
  }

  /**
   * Start this Agent on an explicit native session and wait until the launch completes.
   * Used when a WeeklyReportAssistant wake must not resume `Agent.currentSessionId`.
   */
  async startOnSession(input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    sessionId: string;
    sessionMode: "create" | "resume";
  }): Promise<void> {
    const requestId = crypto.randomUUID();
    const session = { sessionId: input.sessionId, sessionMode: input.sessionMode };
    let drivenRequestId: string = requestId;
    await this.#publisher.withSubjectSession(requestId, session, async () => {
      await this.runtimeLock.run(input.agentId, async () => {
        const agent = await this.#access.authorized(input.userId, input.workspaceId, input.agentId);
        assertAgentLive(agent);
        const inFlight = agent.state;
        if (
          inFlight &&
          inFlight.phase === "starting" &&
          current(agent, inFlight) &&
          agent.identity?.sessionId === input.sessionId &&
          !agent.stoppedAt
        ) {
          drivenRequestId = inFlight.requestId;
          return;
        }
        await this.#operations.begin(agent, "start", requestId, 1, null);
      });
      const result = await this.#driver.drive(input.agentId, drivenRequestId);
      if (result.phase !== "completed") throw new AppError("TEMPORARILY_UNAVAILABLE");
    });
  }

  authorizeLaunch(input: AgentLaunchClaim): Promise<void> {
    return this.#receiver.authorizeLaunch(input);
  }
  result(claim: { workspaceId: string; computerId: string }, result: AgentControlResult) {
    return this.#receiver.result(claim, result);
  }
}
