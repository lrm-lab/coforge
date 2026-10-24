import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  LocalInboxRequestSchema,
  InboxResponseSchema,
  InboxEntrySchema,
  AppInboxItemSchema,
  MessageAttentionSummarySchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import { assertValidMessageSender } from "./message-sender";
import { fromWireRequestId, toWireRequestId } from "./idempotency-key-wire";
import type { MessageAttentionSummary } from "./local-daemon";

export type LocalInboxRequest = {
  idempotencyKey: string;
  context: string;
  operation: "check";
};
/** `until_explicit_ack` items persist until acknowledged; `transient` ones live only in the
 * running daemon's memory. */
export type AppInboxRetention = "until_explicit_ack" | "transient";
export type AppInboxItem = {
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: { kind: string; id: string; revision: string };
  title?: string;
  summary?: string;
  retention: AppInboxRetention;
  action: { kind: "run_command"; commandId: string };
  createdAt: string;
};
export type InboxEntry =
  | { kind: "message_target"; messageTarget: MessageAttentionSummary }
  | { kind: "app"; app: AppInboxItem };
export type InboxResponse = { idempotencyKey: string; accepted: boolean; entries: InboxEntry[] };
export function encodeLocalInboxRequest(value: LocalInboxRequest): Uint8Array {
  return toBinary(LocalInboxRequestSchema, create(LocalInboxRequestSchema, toWireRequestId(value)));
}
export function decodeLocalInboxRequest(bytes: Uint8Array): LocalInboxRequest {
  const { requestId, context, operation } = fromBinary(LocalInboxRequestSchema, bytes);
  if (operation !== "check") throw new Error("invalid App Inbox operation");
  return fromWireRequestId({ requestId, context, operation: "check" as const });
}
export function encodeInboxResponse(value: InboxResponse): Uint8Array {
  for (const entry of value.entries)
    if (entry.kind === "message_target" && entry.messageTarget.latestSenderKind !== undefined)
      assertValidMessageSender(
        entry.messageTarget.latestSenderKind,
        entry.messageTarget.latestSenderHandle ?? "",
        "Inbox message-target",
      );
  return toBinary(
    InboxResponseSchema,
    create(InboxResponseSchema, {
      ...toWireRequestId(value),
      entries: value.entries.map((entry) =>
        create(
          InboxEntrySchema,
          entry.kind === "message_target"
            ? {
                value: {
                  case: "messageTarget",
                  value: create(MessageAttentionSummarySchema, {
                    ...entry.messageTarget,
                    firstPendingSequence: BigInt(entry.messageTarget.firstPendingSequence),
                    latestSequence: BigInt(entry.messageTarget.latestSequence),
                  }),
                },
              }
            : {
                value: {
                  case: "app",
                  value: create(AppInboxItemSchema, {
                    ...entry.app,
                    sourceKind: entry.app.sourceRef.kind,
                    sourceId: entry.app.sourceRef.id,
                    sourceRevision: entry.app.sourceRef.revision,
                    actionKind: entry.app.action.kind,
                    actionCommandId: entry.app.action.commandId,
                  }),
                },
              },
        ),
      ),
    }),
  );
}
export function decodeInboxResponse(bytes: Uint8Array): InboxResponse {
  const value = fromBinary(InboxResponseSchema, bytes);
  return fromWireRequestId({
    requestId: value.requestId,
    accepted: value.accepted,
    entries: value.entries.map((entry): InboxEntry => {
      if (entry.value.case === "messageTarget") {
        const { latestSenderKind, latestSenderHandle } = entry.value.value;
        if (latestSenderKind !== undefined)
          assertValidMessageSender(
            latestSenderKind,
            latestSenderHandle ?? "",
            "Inbox message-target",
          );
        return {
          kind: "message_target",
          messageTarget: {
            target: entry.value.value.target,
            pendingCount: entry.value.value.pendingCount,
            firstPendingSequence: Number(entry.value.value.firstPendingSequence),
            latestSequence: Number(entry.value.value.latestSequence),
            ...(latestSenderKind
              ? {
                  latestSenderKind: latestSenderKind as MessageAttentionSummary["latestSenderKind"],
                  latestSenderHandle,
                }
              : {}),
            flags: entry.value.value.flags,
          },
        };
      }
      if (entry.value.case !== "app") throw new Error("invalid Inbox entry");
      const app = entry.value.value;
      if (
        (app.retention !== "until_explicit_ack" && app.retention !== "transient") ||
        app.actionKind !== "run_command"
      )
        throw new Error("invalid App Inbox entry");
      return {
        kind: "app",
        app: {
          itemId: app.itemId,
          appId: app.appId,
          notificationClass: app.notificationClass,
          sourceRef: { kind: app.sourceKind, id: app.sourceId, revision: app.sourceRevision },
          ...(app.title === undefined ? {} : { title: app.title }),
          ...(app.summary === undefined ? {} : { summary: app.summary }),
          retention: app.retention,
          action: { kind: "run_command", commandId: app.actionCommandId },
          createdAt: app.createdAt,
        },
      };
    }),
  });
}
