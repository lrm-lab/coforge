import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentReminderOperationResponseSchema } from "#src/internal/gen/coforge/rpc/v1/reminder_pb";
import { boundedPayload } from "./codec";
import {
  fields,
  hasReminderCore,
  operationScope,
  type AgentReminderOperationResponse,
  type ReminderLogEvent,
  type ReminderSummaryRecord,
} from "./reminder";
import { instant } from "./reminder-grammar";
import { fromVersionedProto, toVersionedProto } from "./reminder-versioned-wire";
import { isScopeId } from "./scope-id";

const MAX_BYTES = 65_536;
const bounded = (bytes: Uint8Array) => boundedPayload(bytes, MAX_BYTES, "Reminder");
const record = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([key, v]) => key !== "$typeName" && v !== undefined),
  );

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

function response(value: AgentReminderOperationResponse) {
  operationScope(value);
  value.reminders.forEach(summary);
  value.events.forEach(event);
  return value;
}

export function encodeAgentReminderOperationResponse(value: AgentReminderOperationResponse) {
  return bounded(
    toBinary(
      AgentReminderOperationResponseSchema,
      create(AgentReminderOperationResponseSchema, toVersionedProto(response(value))),
    ),
  );
}

export function decodeAgentReminderOperationResponse(
  bytes: Uint8Array,
): AgentReminderOperationResponse {
  const v = fromBinary(AgentReminderOperationResponseSchema, bounded(bytes));
  return response({
    ...fromVersionedProto<AgentReminderOperationResponse>(v),
    reason: v.reason,
    reminders: v.reminders.map((r) => summary(record(r) as ReminderSummaryRecord)),
    events: v.events.map((e) => event(record(e) as ReminderLogEvent)),
  } as AgentReminderOperationResponse);
}
