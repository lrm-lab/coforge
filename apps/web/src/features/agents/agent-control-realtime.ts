import { useSyncExternalStore } from "react";
import { z } from "zod";

import { publicationData } from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { m } from "#src/paraglide/messages";

/**
 * The `agent.control.v1` browser event (task #584): one control operation's phase as the server
 * publishes it on the Agent status channels — `accepted`/`pending` while it runs, then
 * `completed`/`failed`/`superseded`. Control UI reads the latest phase per Agent from the store
 * below; it never opens a subscription of its own.
 */
export const AGENT_CONTROL_ACTIONS = [
  "start",
  "stop",
  "restart",
  "reset-session",
  "full-reset",
] as const;
export type AgentControlActionName = (typeof AGENT_CONTROL_ACTIONS)[number];

export const AGENT_CONTROL_PHASES = [
  "accepted",
  "pending",
  "completed",
  "failed",
  "superseded",
] as const;
export type AgentControlPhaseName = (typeof AGENT_CONTROL_PHASES)[number];

export type AgentControlRealtimeEvent = {
  type: typeof REALTIME_EVENTS.agentControl;
  agentId: string;
  requestId: string;
  action: AgentControlActionName;
  phase: AgentControlPhaseName;
  errorCode?: string;
  detail?: string;
  occurredAtMs: number;
};

const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 512;

const boundedIdSchema = z.string().min(1).max(MAX_ID_CHARS);

const agentControlEventSchema = z.object({
  type: z.literal(REALTIME_EVENTS.agentControl),
  agentId: boundedIdSchema,
  requestId: boundedIdSchema,
  action: z.enum(AGENT_CONTROL_ACTIONS),
  phase: z.enum(AGENT_CONTROL_PHASES),
  errorCode: boundedIdSchema.optional(),
  detail: z
    .string()
    .refine((value) => [...value].length <= MAX_TEXT_CHARS)
    .optional(),
  occurredAtMs: z.int().min(1),
});

export function isAgentControlEvent(value: unknown): value is AgentControlRealtimeEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.get(value as object, "type") === REALTIME_EVENTS.agentControl
  );
}

export function decodeAgentControlEvent(data: unknown): AgentControlRealtimeEvent {
  const parsed = agentControlEventSchema.safeParse(publicationData(data));
  if (!parsed.success) throw new Error("invalid Agent control event");
  return parsed.data;
}

/** What the store keeps per Agent: the newest event, with a phase-only event never erasing the
 * error fields of the fuller event for the same request. */
export type AgentControlState = Omit<AgentControlRealtimeEvent, "type">;

/** A pending phase this old is treated as a missed terminal event, not a live operation. */
export const AGENT_CONTROL_PENDING_TTL_MS = 5 * 60_000;

const states = new Map<string, AgentControlState>();
const listeners = new Map<string, Set<() => void>>();

function merge(
  existing: AgentControlState | undefined,
  incoming: AgentControlState,
): AgentControlState {
  if (!existing || incoming.occurredAtMs > existing.occurredAtMs) {
    const next = { ...incoming };
    // A phase-only event must not overwrite the richer state of the same request.
    if (
      existing &&
      existing.requestId === incoming.requestId &&
      incoming.errorCode === undefined &&
      incoming.detail === undefined
    ) {
      if (existing.errorCode !== undefined) next.errorCode = existing.errorCode;
      if (existing.detail !== undefined) next.detail = existing.detail;
    }
    return next;
  }
  return existing;
}

export function recordAgentControlEvent(event: AgentControlRealtimeEvent): void {
  const { type: _type, ...state } = event;
  states.set(event.agentId, merge(states.get(event.agentId), state));
  for (const listener of listeners.get(event.agentId) ?? []) listener();
}

export function agentControlState(agentId: string): AgentControlState | undefined {
  return states.get(agentId);
}

export function subscribeAgentControl(agentId: string, listener: () => void): () => void {
  let pending = listeners.get(agentId);
  if (!pending) listeners.set(agentId, (pending = new Set()));
  pending.add(listener);
  return () => {
    pending.delete(listener);
    if (pending.size === 0 && listeners.get(agentId) === pending) listeners.delete(agentId);
  };
}

/** The Agent's latest control phase, `undefined` while none is known or a stale pending one has
 * lapsed. A pending entry past `AGENT_CONTROL_PENDING_TTL_MS` is ignored: its terminal event was
 * missed, and the status pipeline — not this store — owns the settled state. */
export function useAgentControlState(agentId: string): AgentControlState | undefined {
  return useSyncExternalStore(
    (listener) => subscribeAgentControl(agentId, listener),
    () => latestAgentControlState(agentId),
    () => undefined,
  );
}

/** What `useAgentControlState` shows right now, for a handler that must judge the Agent at the
 * moment it runs, not as it was when the handler was made. */
export function latestAgentControlState(agentId: string): AgentControlState | undefined {
  const state = states.get(agentId);
  if (
    state &&
    (state.phase === "accepted" || state.phase === "pending") &&
    Date.now() - state.occurredAtMs > AGENT_CONTROL_PENDING_TTL_MS
  )
    return undefined;
  return state;
}

/** Whether the Agent has a control operation in flight, per the latest event. */
export function agentControlInFlight(state: AgentControlState | undefined): boolean {
  return state?.phase === "accepted" || state?.phase === "pending";
}

/** The localized "正在…" label a pending control phase shows, or `undefined` once it settles. */
export function agentControlPendingLabel(state: AgentControlState | undefined): string | undefined {
  if (!agentControlInFlight(state)) return undefined;
  switch (state!.action) {
    case "start":
      return m.agent_control_start_pending();
    case "stop":
      return m.agent_control_stop_pending();
    case "restart":
      return m.agent_control_restart_pending();
    case "reset-session":
    case "full-reset":
      return m.agent_control_reset_pending();
  }
}
