import type { AgentActivityKind } from "@lrm/coforge-sdk/internal";

export const EXTERNAL_ACTIVITY_SCHEMA = "coforge-agent-activity-ingest.v1";
export const EXTERNAL_ACTIVITY_MAX_EVENTS = 100;
export const EXTERNAL_STATUS_DETAIL_MAX = 200;
const EVENT_ID_MAX = 128;
const HOOK_NAME_MAX = 64;
const PHASE_MAX = 40;

const REPORTED_STATUSES: ReadonlySet<string> = new Set([
  "online",
  "thinking",
  "working",
  "error",
  "offline",
]);
const LEGACY_OUTCOMES: ReadonlySet<string> = new Set([
  "started",
  "succeeded",
  "failed",
  "completed",
]);

export type ExternalActivityRefusalCode =
  | "invalid_request"
  | "events_invalid"
  | "too_many_events"
  | "status_invalid"
  | "detail_invalid"
  | "detail_too_long";

export type ExternalActivityEvent = {
  rejected: boolean;
  eventId?: string;
  occurredAtMs: number;
  report?: { kind: AgentActivityKind; detail: string };
  hook?: { name: string; toolName?: string; toolInput?: string; callId?: string };
  subagent?: { parentToolUseId: string; subagentType?: string; phase?: string };
};

export type ExternalActivityParse =
  | { ok: true; events: ExternalActivityEvent[] }
  | { ok: false; code: ExternalActivityRefusalCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePoints(value: string): number {
  return [...value].length;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function occurredAt(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function text(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && codePoints(value) <= max ? value : null;
}

function validateWhole(events: readonly unknown[]): ExternalActivityRefusalCode | undefined {
  for (const event of events) {
    if (!isRecord(event)) continue;
    const { status, detail } = event;
    if (
      status !== undefined &&
      (typeof status !== "string" ||
        !(REPORTED_STATUSES.has(status) || LEGACY_OUTCOMES.has(status)))
    )
      return "status_invalid";
    if (detail !== undefined && typeof detail !== "string") return "detail_invalid";
    if (typeof detail === "string" && codePoints(detail) > EXTERNAL_STATUS_DETAIL_MAX)
      return "detail_too_long";
  }
  return undefined;
}

function parseEvent(raw: unknown, now: number): ExternalActivityEvent {
  const rejected: ExternalActivityEvent = { rejected: true, occurredAtMs: now };
  if (!isRecord(raw)) return rejected;
  const status = typeof raw.status === "string" && REPORTED_STATUSES.has(raw.status);
  const eventId = text(raw.eventId, EVENT_ID_MAX);
  const time = raw.occurredAt === undefined ? undefined : occurredAt(raw.occurredAt);
  if (eventId === null || (raw.occurredAt !== undefined && time === undefined)) return rejected;
  if (status && (eventId === undefined || time === undefined)) return rejected;

  const name = text(raw.hookEventName, HOOK_NAME_MAX);
  const toolName = text(raw.toolName, 128);
  const toolInput = text(raw.toolInput, 200);
  const callId = text(raw.callId, 128);
  if (name === null || toolName === null || toolInput === null || callId === null) return rejected;
  if (raw.hookEventName === undefined && raw.toolName !== undefined) return rejected;

  let subagent: ExternalActivityEvent["subagent"];
  if (raw.subagent !== undefined) {
    if (!isRecord(raw.subagent)) return rejected;
    const parent = text(raw.subagent.parentToolUseId, 128);
    const type = text(raw.subagent.subagentType, 40);
    const phase = text(raw.subagent.phase, PHASE_MAX);
    if (!parent || type === null || phase === null) return rejected;
    subagent = {
      parentToolUseId: parent,
      ...(type ? { subagentType: type } : {}),
      ...(phase ? { phase } : {}),
    };
  }

  const kind = status ? (raw.status as AgentActivityKind) : undefined;
  const detail = typeof raw.detail === "string" ? singleLine(raw.detail) : "";
  return {
    rejected: false,
    ...(eventId ? { eventId } : {}),
    occurredAtMs: Math.min(time ?? now, now),
    ...(kind
      ? { report: { kind, detail: kind === "working" || kind === "error" ? detail : "" } }
      : {}),
    ...(name
      ? {
          hook: {
            name,
            ...(toolName ? { toolName } : {}),
            ...(toolInput ? { toolInput } : {}),
            ...(callId ? { callId } : {}),
          },
        }
      : {}),
    ...(subagent ? { subagent } : {}),
  };
}

export function parseExternalActivityIngest(body: unknown, now: number): ExternalActivityParse {
  if (!isRecord(body) || body.schema !== EXTERNAL_ACTIVITY_SCHEMA)
    return { ok: false, code: "invalid_request" };
  if (!Array.isArray(body.events)) return { ok: false, code: "events_invalid" };
  if (body.events.length > EXTERNAL_ACTIVITY_MAX_EVENTS)
    return { ok: false, code: "too_many_events" };
  const refusal = validateWhole(body.events);
  if (refusal) return { ok: false, code: refusal };
  return { ok: true, events: body.events.map((event) => parseEvent(event, now)) };
}
