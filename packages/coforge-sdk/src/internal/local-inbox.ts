import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  LocalInboxRequestSchema,
  InboxResponseSchema,
  InboxEntrySchema,
  AppInboxItemSchema,
  InboxSealSchema,
  MessageAttentionSummarySchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import { fromWireRequestId, toWireRequestId } from "./idempotency-key-wire";
import {
  decodeMessageAttentionSummary,
  encodeMessageAttentionSummary,
  type MessageAttentionSummary,
} from "./local-attention-summary";

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
/** One sealed App Inbox source identity, as `inbox check` reports it. `state` is `SEALED` when the
 * registered revision is live, `STALE` when the live revision moved past it, and `DETACHED` when
 * it was sealed without a revision or nothing live matches it. */
export type InboxSeal = {
  appId: string;
  notificationClass: string;
  sourceRef: { kind: string; id: string; revision?: string };
  owner: string;
  until: string;
  sealedAt: string;
  state: "SEALED" | "STALE" | "DETACHED";
  liveRevision?: string;
};
export type InboxResponse = {
  idempotencyKey: string;
  accepted: boolean;
  entries: InboxEntry[];
  seals: InboxSeal[];
};
export function encodeLocalInboxRequest(value: LocalInboxRequest): Uint8Array {
  return toBinary(LocalInboxRequestSchema, create(LocalInboxRequestSchema, toWireRequestId(value)));
}
export function decodeLocalInboxRequest(bytes: Uint8Array): LocalInboxRequest {
  const { requestId, context, operation } = fromBinary(LocalInboxRequestSchema, bytes);
  if (operation !== "check") throw new Error("invalid App Inbox operation");
  return fromWireRequestId({ requestId, context, operation: "check" as const });
}
export function encodeInboxResponse(value: InboxResponse): Uint8Array {
  return toBinary(
    InboxResponseSchema,
    create(InboxResponseSchema, {
      ...toWireRequestId(value),
      seals: value.seals.map((seal) =>
        create(InboxSealSchema, {
          appId: seal.appId,
          notificationClass: seal.notificationClass,
          sourceKind: seal.sourceRef.kind,
          sourceId: seal.sourceRef.id,
          ...(seal.sourceRef.revision === undefined
            ? {}
            : { sourceRevision: seal.sourceRef.revision }),
          owner: seal.owner,
          until: seal.until,
          sealedAt: seal.sealedAt,
          state: seal.state,
          ...(seal.liveRevision === undefined ? {} : { liveRevision: seal.liveRevision }),
        }),
      ),
      entries: value.entries.map((entry) =>
        create(
          InboxEntrySchema,
          entry.kind === "message_target"
            ? {
                value: {
                  case: "messageTarget",
                  value: create(
                    MessageAttentionSummarySchema,
                    encodeMessageAttentionSummary(entry.messageTarget),
                  ),
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
    seals: value.seals.map((seal): InboxSeal => {
      if (seal.state !== "SEALED" && seal.state !== "STALE" && seal.state !== "DETACHED")
        throw new Error("invalid App Inbox seal");
      return {
        appId: seal.appId,
        notificationClass: seal.notificationClass,
        sourceRef: {
          kind: seal.sourceKind,
          id: seal.sourceId,
          ...(seal.sourceRevision === undefined ? {} : { revision: seal.sourceRevision }),
        },
        owner: seal.owner,
        until: seal.until,
        sealedAt: seal.sealedAt,
        state: seal.state,
        ...(seal.liveRevision === undefined ? {} : { liveRevision: seal.liveRevision }),
      };
    }),
    entries: value.entries.map((entry): InboxEntry => {
      if (entry.value.case === "messageTarget") {
        return {
          kind: "message_target",
          messageTarget: decodeMessageAttentionSummary(entry.value.value),
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
