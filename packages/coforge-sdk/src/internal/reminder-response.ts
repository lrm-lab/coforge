import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentReminderOperationResponseSchema } from "#src/internal/gen/coforge/rpc/v1/reminder_pb";
import {
  bounded,
  fields,
  hasReminderCore,
  operationScope,
  type AgentReminderOperationResponse,
  type ReminderLogEvent,
  type ReminderSummaryRecord,
} from "./reminder";
import { instant } from "./reminder-grammar";
import { fromVersionedProto, optional, toVersionedProto } from "./reminder-versioned-wire";
import { isScopeId } from "./scope-id";

function timeZone(value: string): string | undefined {
  if (value.length === 0 || value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    return undefined;
  }
  return value;
}

function summary(value: ReminderSummaryRecord): ReminderSummaryRecord {
  fields(value, true);
  if (
    !hasReminderCore(value) ||
    !instant(value.createdAt, "reminder created time") ||
    value.repeat === "none" ||
    (value.firedAt !== undefined && !instant(value.firedAt, "reminder fired time"))
  )
    throw new Error("invalid reminder summary");
  return value;
}

function event(value: ReminderLogEvent): ReminderLogEvent {
  if (
    !isScopeId(value.eventId) ||
    !isScopeId(value.type) ||
    !instant(value.time, "reminder event time") ||
    (value.nextFireAt !== undefined && !instant(value.nextFireAt, "next reminder fire time"))
  )
    throw new Error("invalid reminder event");
  return value;
}

function withoutUnusableTimeZone(value: AgentReminderOperationResponse) {
  const { displayTimezone, ...rest } = value;
  const usable = displayTimezone === undefined ? undefined : timeZone(displayTimezone);
  return usable === undefined ? rest : { ...rest, displayTimezone: usable };
}

export function encodeAgentReminderOperationResponse(value: AgentReminderOperationResponse) {
  operationScope(value);
  value.reminders.forEach(summary);
  value.events.forEach(event);
  return bounded(
    toBinary(
      AgentReminderOperationResponseSchema,
      create(
        AgentReminderOperationResponseSchema,
        toVersionedProto(withoutUnusableTimeZone(value)),
      ),
    ),
  );
}

export function decodeAgentReminderOperationResponse(
  bytes: Uint8Array,
): AgentReminderOperationResponse {
  const v = fromBinary(AgentReminderOperationResponseSchema, bounded(bytes));
  return operationScope(
    withoutUnusableTimeZone({
      ...fromVersionedProto<AgentReminderOperationResponse>(v),
      reason: v.reason,
      reminders: v.reminders.map((r) => summary(optional(r) as ReminderSummaryRecord)),
      events: v.events.map((e) => event(optional(e) as ReminderLogEvent)),
    } as AgentReminderOperationResponse),
  );
}
