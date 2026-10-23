import { APP_AGENT_INBOUND_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";

/**
 * Agent inbound: what an installed app may send to one Agent, as both the server
 * (`server/app-agent-events/`) and the browser name it. Pure and client-safe.
 */

/** The kinds an app may send. `action_request` is reserved and refused: an event informs, it never
 * asks the Agent to act. */
export const AGENT_EVENT_KINDS = ["event", "notification"] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** The scope that lets an app send each kind. */
export const AGENT_EVENT_KIND_SCOPE = {
  event: "agent:event:write",
  notification: "agent:notification:write",
} as const satisfies Record<AgentEventKind, (typeof APP_AGENT_INBOUND_SCOPES)[number]>;

/** The longest summary, counted as code points after whitespace is normalised. */
export const AGENT_EVENT_SUMMARY_MAX_LENGTH = 500;
/** The largest payload, serialised as JSON and counted in UTF-8 bytes. */
export const AGENT_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;
/** The longest Message body an event becomes, once escaped and pretty-printed: the limit of a
 * person's message (`sendConversationMessageInputSchema`). A payload that renders longer is refused
 * as too large, since escaping can multiply the characters a payload is made of. */
export const AGENT_EVENT_MESSAGE_MAX_LENGTH = 8_000;
export const AGENT_EVENT_EXTERNAL_ID_MAX_LENGTH = 200;
export const AGENT_EVENT_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_EVENT_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The largest request body read before it is parsed: the payload, plus room for the other fields. */
export const AGENT_EVENT_BODY_MAX_BYTES = AGENT_EVENT_PAYLOAD_MAX_BYTES + 4 * 1024;

/** An event as the app sent it, checked. */
export type AgentEventInput = {
  kind: AgentEventKind;
  summary: string;
  payload: Record<string, unknown>;
  externalEventId: string | null;
  ttlSeconds: number;
  /** The Agent the app named, which must be the token's: it cannot retarget an event. */
  agentId: string | null;
};

export type AgentEventInputResult =
  | { ok: true; value: AgentEventInput }
  | { ok: false; description: string };

const refuse = (description: string): AgentEventInputResult => ({ ok: false, description });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `value` with every run of whitespace made one space and the ends trimmed. */
export const normalizeSummary = (value: string) => value.replace(/\s+/gu, " ").trim();

/** The scopes of the kinds, in `APP_AGENT_INBOUND_SCOPES` order. */
export const isAgentInboundScope = (
  scope: string,
): scope is (typeof APP_AGENT_INBOUND_SCOPES)[number] =>
  (APP_AGENT_INBOUND_SCOPES as readonly string[]).includes(scope);

/** Checks the JSON an app posted to the event endpoint (snake_case, as the other endpoints an app
 * calls): the refusal's description names the first field that is wrong. */
export function parseAgentEventInput(body: unknown): AgentEventInputResult {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refuse("the body must be a JSON object");
  const { kind, summary, payload, external_event_id, ttl_seconds, agent_id } = body as Record<
    string,
    unknown
  >;
  if (kind === "action_request") return refuse("kind action_request is reserved and not accepted");
  if (typeof kind !== "string" || !(AGENT_EVENT_KINDS as readonly string[]).includes(kind))
    return refuse("kind must be event or notification");
  if (typeof summary !== "string") return refuse("summary is required");
  const normalized = normalizeSummary(summary);
  if (!normalized) return refuse("summary must not be empty");
  if ([...normalized].length > AGENT_EVENT_SUMMARY_MAX_LENGTH)
    return refuse(`summary must be at most ${AGENT_EVENT_SUMMARY_MAX_LENGTH} characters`);
  if (
    payload !== undefined &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  )
    return refuse("payload must be a JSON object");
  const record = (payload ?? {}) as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(record)).length > AGENT_EVENT_PAYLOAD_MAX_BYTES)
    return refuse(`payload must be at most ${AGENT_EVENT_PAYLOAD_MAX_BYTES} bytes`);
  if (
    external_event_id !== undefined &&
    (typeof external_event_id !== "string" ||
      external_event_id.length === 0 ||
      external_event_id.length > AGENT_EVENT_EXTERNAL_ID_MAX_LENGTH)
  )
    return refuse(
      `external_event_id must be 1 to ${AGENT_EVENT_EXTERNAL_ID_MAX_LENGTH} characters`,
    );
  if (
    ttl_seconds !== undefined &&
    (typeof ttl_seconds !== "number" || !Number.isFinite(ttl_seconds) || ttl_seconds <= 0)
  )
    return refuse("ttl_seconds must be a positive number");
  if (agent_id !== undefined && (typeof agent_id !== "string" || !UUID.test(agent_id)))
    return refuse("agent_id must be an Agent id");
  return {
    ok: true,
    value: {
      kind: kind as AgentEventKind,
      summary: normalized,
      payload: record,
      externalEventId: (external_event_id as string | undefined) ?? null,
      ttlSeconds: Math.min(
        Math.ceil((ttl_seconds as number | undefined) ?? AGENT_EVENT_DEFAULT_TTL_SECONDS),
        AGENT_EVENT_MAX_TTL_SECONDS,
      ),
      agentId: (agent_id as string | undefined) ?? null,
    },
  };
}
