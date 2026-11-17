import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ReminderDueSchema,
  ReminderDueAckRequestSchema,
  ReminderDueAckResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/reminder_pb";
import { boundedPayload } from "./codec";
import { isScopeId } from "./scope-id";
import { RPC_METHODS } from "./rpc-methods";
import {
  isReminderId,
  validateReminderJob,
  type ReminderIdentity,
  type ReminderJob,
} from "./reminder";

export const REMINDER_DUE_CAPABILITY = "reminder-due:v1" as const;
export const REMINDER_DUE_MESSAGE_TYPE = "reminder:due:v1" as const;
export const REMINDER_DUE_ACK_METHOD = RPC_METHODS.reminderDueAck;

type DueIdentity = ReminderIdentity & { protocolMajor: number; occurrenceId: string };
export type ReminderDue = DueIdentity & {
  job: ReminderJob;
  expiresAt: string;
  messageType: typeof REMINDER_DUE_MESSAGE_TYPE;
};
export type ReminderDueAckRequest = DueIdentity & {
  requestId: string;
  reminderId: string;
  version: number;
};
export type ReminderDueAckResponse = ReminderDueAckRequest & { accepted: boolean; reason?: string };

function identity(value: DueIdentity) {
  if (
    value.protocolMajor !== 1 ||
    !isReminderId(value.occurrenceId) ||
    ![value.workspaceId, value.computerId, value.agentId].every(isScopeId)
  )
    throw new Error("invalid reminder due identity");
}

function due(value: ReminderDue): ReminderDue {
  identity(value);
  if (!value.job) throw new Error("missing reminder due job");
  validateReminderJob(value.job);
  if (
    value.job.ownerAgentId !== value.agentId ||
    value.messageType !== REMINDER_DUE_MESSAGE_TYPE ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.job.fireAt)
  )
    throw new Error("invalid reminder due");
  return value;
}

function ack<T extends ReminderDueAckRequest>(value: T): T {
  identity(value);
  if (
    !isScopeId(value.requestId) ||
    !isReminderId(value.reminderId) ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    value.version > 0xffffffff
  )
    throw new Error("invalid reminder due acknowledgement");
  return value;
}

const bounded = (bytes: Uint8Array) => boundedPayload(bytes, 65_536, "ReminderDue");

export function encodeReminderDue(value: ReminderDue): Uint8Array {
  return bounded(toBinary(ReminderDueSchema, create(ReminderDueSchema, due(value))));
}

export function decodeReminderDue(bytes: Uint8Array): ReminderDue {
  const { $typeName: _, job, ...value } = fromBinary(ReminderDueSchema, bounded(bytes));
  if (!job) throw new Error("missing reminder due job");
  const { $typeName: _jobType, ...fields } = job;
  return due({
    ...value,
    job: fields,
    messageType: value.messageType as typeof REMINDER_DUE_MESSAGE_TYPE,
  });
}

export function encodeReminderDueAckRequest(value: ReminderDueAckRequest): Uint8Array {
  return bounded(
    toBinary(ReminderDueAckRequestSchema, create(ReminderDueAckRequestSchema, ack(value))),
  );
}

export function decodeReminderDueAckRequest(bytes: Uint8Array): ReminderDueAckRequest {
  const { $typeName: _, ...value } = fromBinary(ReminderDueAckRequestSchema, bounded(bytes));
  return ack(value);
}

export function encodeReminderDueAckResponse(value: ReminderDueAckResponse): Uint8Array {
  return bounded(
    toBinary(ReminderDueAckResponseSchema, create(ReminderDueAckResponseSchema, ack(value))),
  );
}

export function decodeReminderDueAckResponse(bytes: Uint8Array): ReminderDueAckResponse {
  const { $typeName: _, ...value } = fromBinary(ReminderDueAckResponseSchema, bounded(bytes));
  return ack(value);
}
