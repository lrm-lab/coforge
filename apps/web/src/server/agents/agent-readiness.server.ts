import type { AgentRuntimeSelectionRefusal } from "./agent-runtime-availability.server";

export type ReadinessResource = "computer" | "runtime" | "login";
export type ReadinessBehaviour = "blocked" | "waiting" | "advisory";
export type ReadinessActor = "none" | "computer_owner" | "agent_owner";
export type ReadinessExit =
  | "computer_reconnects"
  | "upgrade_deadline_elapsed"
  | "runtime_reported_usable"
  | "person_signs_in_and_starts";

export const READINESS_STATES = {
  computer_updating: {
    resource: "computer",
    behaviour: "waiting",
    actor: "none",
    exits: ["computer_reconnects", "upgrade_deadline_elapsed"],
  },
  computer_offline: {
    resource: "computer",
    behaviour: "blocked",
    actor: "computer_owner",
    exits: ["computer_reconnects"],
  },
  runtime_missing: {
    resource: "runtime",
    behaviour: "blocked",
    actor: "computer_owner",
    exits: ["runtime_reported_usable"],
  },
  runtime_login_required: {
    resource: "login",
    behaviour: "blocked",
    actor: "agent_owner",
    exits: ["person_signs_in_and_starts"],
  },
} as const satisfies Record<
  string,
  {
    resource: ReadinessResource;
    behaviour: ReadinessBehaviour;
    actor: ReadinessActor;
    exits: readonly ReadinessExit[];
  }
>;

export type ReadinessState = keyof typeof READINESS_STATES;

const PRECEDENCE = [
  "computer_updating",
  "computer_offline",
  "runtime_missing",
  "runtime_login_required",
] as const satisfies readonly ReadinessState[];

export type AgentReadiness =
  | { state: "ready" }
  | {
      state: ReadinessState;
      resource: ReadinessResource;
      behaviour: ReadinessBehaviour;
      actor: ReadinessActor;
      exits: readonly ReadinessExit[];
      also: readonly ReadinessState[];
    };

export type AgentReadinessInput = {
  nowMs: number;
  computerOnline: boolean;
  upgradeExpiresAtMs: number | null;
  runtimeRefusal: AgentRuntimeSelectionRefusal | null;
  stopReason: string | null;
};

const RUNTIME_MISSING_REFUSALS: readonly AgentRuntimeSelectionRefusal[] = [
  "runtime_missing",
  "runtime_unusable",
  "runtime_unconfirmed",
];

const LOGIN_REQUIRED_STOP_REASON = "runtime_login_required";

export const READY: AgentReadiness = { state: "ready" };

export function agentReadiness(input: AgentReadinessInput): AgentReadiness {
  const active = new Set<ReadinessState>();
  if (input.upgradeExpiresAtMs !== null && input.nowMs < input.upgradeExpiresAtMs)
    active.add("computer_updating");
  if (!input.computerOnline || input.runtimeRefusal === "not_connected")
    active.add("computer_offline");
  if (input.runtimeRefusal !== null && RUNTIME_MISSING_REFUSALS.includes(input.runtimeRefusal))
    active.add("runtime_missing");
  if (input.stopReason === LOGIN_REQUIRED_STOP_REASON) active.add("runtime_login_required");
  const [state, ...also] = PRECEDENCE.filter((candidate) => active.has(candidate));
  if (!state) return READY;
  return { state, ...READINESS_STATES[state], also };
}

export function readinessSelfHeals(readiness: AgentReadiness): boolean {
  return readiness.state !== "ready" && readiness.behaviour === "waiting";
}
