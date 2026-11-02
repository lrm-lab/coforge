import type {
  AgentControlScope,
  AgentStartIntent,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "./agent-runtime-config.server";
import type { AgentIntroductionFacts } from "./agent-introduction.server";
import type { AcceptedSessionMentions } from "./agent-sessions.server";
import type {
  AgentControlCapability,
  WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** Only the recovery fields a Start intent may carry; a full `AgentStartIntent` (e.g.
 * `recover()`'s) structurally satisfies this too. */
export type AgentRecoveryFields = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary" | "unreadConversationIds"
>;
/** Reads the surfaced-while-stopped recovery context for a user-initiated Start; the
 * same shape `WorkspaceAgentRecovery.recoverWorkspace` reads for Daemon-ready recovery. */
export type AgentControlRecoveryReader = {
  readAgentRecoveryContext(workspaceId: string, agentId: string): Promise<AgentRecoveryFields>;
};

/** Application button intent; never sent as a daemon command. */
export type AgentControlAction = "start" | "stop" | "restart" | "reset-session" | "full-reset";
export type AgentControlStep = "stop" | "reset-workspace" | "clear-session" | "start";

/** Whether a Start intent already brings unread-message recovery of its own. */
export function carriesRecovery(intent: AgentRecoveryFields): boolean {
  return Boolean(
    intent.wakeMessage ||
    intent.resumeMessages?.length ||
    Object.keys(intent.unreadSummary ?? {}).length,
  );
}

export const chains: Record<AgentControlAction, readonly AgentControlStep[]> = {
  start: ["start"],
  stop: ["stop"],
  restart: ["stop", "start"],
  "reset-session": ["stop", "clear-session", "start"],
  "full-reset": ["stop", "reset-workspace", "clear-session", "start"],
};

export const commands = {
  stop: { pending: "stopping", result: "stopped", completed: "stopped" },
  "reset-workspace": {
    pending: "clearing",
    result: "workspace-reset",
    completed: "workspace-reset",
  },
  start: { pending: "starting", result: "started", completed: "completed" },
} as const;

/** How many Agents `stopMany`/`startMany` change at once: each holds a runtime-lock connection
 * and a transaction, and both pools default to 10 connections for the whole process. */
export const CONTROL_MANY_CONCURRENCY = 4;

/** The capability required for each user-initiated execute() action. Start and Stop need only
 * `controlAgentRuntime`, the same as Restart and Reset session. */
export const EXECUTE_CAPABILITY: Record<AgentControlAction, AgentControlCapability> = {
  start: "controlAgentRuntime",
  stop: "controlAgentRuntime",
  restart: "controlAgentRuntime",
  "reset-session": "controlAgentRuntime",
  "full-reset": "resetAgentWorkspace",
};

export type AgentControlState = AgentControlScope & {
  version: 1;
  action: AgentControlAction;
  phase:
    | "stopping"
    | "stopped"
    | "clearing"
    | "workspace-reset"
    | "starting"
    | "completed"
    | "failed";
  configRevision: string;
  identity?: SessionIdentity;
  launchId?: string;
  /** True after this launch has bound its first provider-native identity. */
  launchIdentityBound?: boolean;
  recovered?: boolean;
  controlSequence: number;
  sessionSequence: number;
  errorCode?: string;
};

export type AgentControlAgent = {
  id: string;
  workspaceId: string;
  computerId: string;
  ownerId: string;
  /** Required, not defaulted: `authorizedForExecute` reads this directly with no
   * `?? "public"` fallback, so a select that ever forgot to fetch it fails a type check instead
   * of silently failing open and treating an unseen private Agent as visible. */
  visibility: string;
  systemKind?: string | null;
  runtimeConfig: AgentRuntimeConfig;
  /** Opaque persisted representation used only for compare-and-swap. */
  storedRuntimeConfig?: unknown;
  storedRuntimeSession?: unknown;
  /** Opaque persisted `controlState` JSON exactly as stored, used only for compare-and-swap.
   * A legacy row may still carry a `updatedAtMs` key that `state` below never reflects;
   * using this raw value keeps the CAS predicate matching the real row instead of losing
   * every compare-and-swap against it. */
  storedControlState?: unknown;
  state: AgentControlState | null;
  currentSessionId?: string | null;
  identity?: SessionIdentity;
  /**
   * Set while a migration that has not switched yet holds the Agent: its workspace is moving off
   * the Computer, so nothing may start it there. Read model only, not part of the CAS fence.
   */
  migrating?: boolean;
  /** Set when a user stopped this Agent; read model only, not part of the CAS fence. */
  stoppedAt?: Date | null;
  /** Set when a user deleted this Agent; read model only, not part of the CAS fence.
   * The internal paths (`recover`, `publishStop`) still operate on a deleted Agent so a Stop can
   * reconcile one the Daemon still runs; the user-initiated `execute()` refuses it outright. */
  deletedAt?: Date | null;
  // And, from `AgentIntroductionFacts`, the introduction it owes its creator: read model only,
  // not part of the CAS fence.
} & AgentIntroductionFacts;

/** The tracked @mentions a control change affects: a person's Stop settles them as not launched,
 * and a launch that started with its session issues them again for it. */
export type AgentControlMentions = AcceptedSessionMentions & {
  settleStopped(input: { workspaceId: string; agentId: string; stoppedAt: Date }): Promise<void>;
};

/** get/replace both require current owner membership and Workspace–Computer assignment. */
export interface AgentControlStore {
  get(agentId: string): Promise<AgentControlAgent | undefined>;
  /** Clear Session, when requested, commits in the same transaction as the next phase. Setting
   * `stoppedAt` writes the Agent's persisted stop/start intent in that same
   * transaction; `undefined` leaves it unchanged. This flag is last-writer-wins, not part of the
   * optimistic-concurrency fence `replace` already applies to `controlState`. */
  replace(
    before: AgentControlAgent,
    state: AgentControlState,
    options?: { clearSession?: boolean; stoppedAt?: Date | null },
  ): Promise<boolean>;
  /** The ACTOR's current Workspace role; undefined when the actor is not a member. Used only by
   * execute()'s capability check, never by the Agent-record authorization above. */
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
}

export type AgentControlView = {
  requestId: string;
  action: AgentControlAction;
  /** `"superseded"` is a view-only outcome: the driven request was replaced by a
   * newer command on the same Agent before it reached a terminal phase. It is never a persisted
   * `AgentControlState.phase` — only ever synthesized by `drive()` for the caller that lost the
   * race. */
  phase: "pending" | "completed" | "failed" | "superseded";
  error?: string;
  recovered?: boolean;
};

export function agentControlRevision(config: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(config)).digest("hex");
}

export function terminal(state: AgentControlState) {
  return state.phase === "completed" || state.phase === "failed";
}

export function view(state: AgentControlState): AgentControlView {
  return {
    requestId: state.requestId,
    action: state.action,
    phase: state.phase === "completed" || state.phase === "failed" ? state.phase : "pending",
    ...(state.errorCode ? { error: state.errorCode } : {}),
    ...(state.recovered ? { recovered: true } : {}),
  };
}

/** The view `drive()` returns to the caller whose request was superseded by a newer command on
 * the same Agent, instead of the "Agent operation scope changed" throw a genuine scope change
 * (Agent moved Computer, config revision changed, Agent gone) still produces. */
export function supersededView(state: AgentControlState): AgentControlView {
  return { requestId: state.requestId, action: state.action, phase: "superseded" };
}

export function current(agent: AgentControlAgent, state: AgentControlState) {
  return (
    agent.workspaceId === state.workspaceId &&
    agent.computerId === state.computerId &&
    agent.runtimeConfig.runtime === state.provider &&
    agentControlRevision(agent.runtimeConfig) === state.configRevision
  );
}

/**
 * Where the Agent's latest control operation stands, for a caller deciding whether a new Start
 * may be sent: `in_flight` while any operation is unfinished (for this configuration or an older
 * one), `failed` when the latest operation for the current Computer and configuration ended failed
 * after it began a Start or a chain ending in one (whatever step failed), `settled` otherwise.
 */
export function controlOperationState(
  agent: AgentControlAgent,
): "in_flight" | "failed" | "settled" {
  const state = agent.state;
  if (!state) return "settled";
  if (!terminal(state)) return "in_flight";
  if (current(agent, state) && state.phase === "failed" && state.action !== "stop") return "failed";
  return "settled";
}

export function sameScope(a: AgentControlScope, b: AgentControlScope) {
  return (
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.provider === b.provider &&
    a.epoch === b.epoch &&
    a.requestId === b.requestId
  );
}

export function operationFence(state: AgentControlState | null) {
  if (!state) return null;
  const {
    identity: _identity,
    sessionSequence: _sessionSequence,
    launchIdentityBound: _launchIdentityBound,
    recovered: _recovered,
    ...fence
  } = state;
  return fence;
}
