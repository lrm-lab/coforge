import { create, createFileRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FieldDescriptorProto_Type } from "@bufbuild/protobuf/wkt";
import { expect, test } from "bun:test";
import {
  AgentStartIntentSchema,
  AgentUnreadSummaryEntrySchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { decodeAgentStartIntent, encodeAgentStartIntent, type AgentStartIntent } from "./index";

const start = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex" as const,
  model: "gpt-5",
  reasoning: "medium",
  unreadSummary: { "#alpha": 2 },
  unreadConversationIds: { "#alpha": "conversation-alpha" },
};

const legacySummarySchema = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: "legacy-unread-summary.proto",
    syntax: "proto2",
    messageType: [
      {
        name: "AgentUnreadSummaryEntry",
        field: [
          { name: "target", number: 1, type: FieldDescriptorProto_Type.STRING },
          { name: "count", number: 2, type: FieldDescriptorProto_Type.UINT32 },
          { name: "conversation_id", number: 3, type: FieldDescriptorProto_Type.STRING },
        ],
      },
    ],
  }),
  () => undefined,
).getMessage("AgentUnreadSummaryEntry")!;

test("old and new unread summary writers and readers interoperate", () => {
  const entry = { target: "#alpha", count: 2, conversationId: "conversation-alpha" };
  const legacyBytes = toBinary(legacySummarySchema, create(legacySummarySchema, entry));
  const newEntry = fromBinary(
    AgentStartIntentSchema,
    encodeAgentStartIntent({ ...start, lastUnreadSequences: { "#alpha": 12 } }),
  ).unreadSummary[0]!;
  const newBytes = toBinary(AgentUnreadSummaryEntrySchema, newEntry);
  const legacyView = { ...entry, $typeName: legacySummarySchema.typeName };
  expect(fromBinary(legacySummarySchema, legacyBytes)).toEqual(legacyView);
  expect(fromBinary(legacySummarySchema, newBytes, { readUnknownFields: false })).toEqual(
    legacyView,
  );
  expect(fromBinary(AgentUnreadSummaryEntrySchema, legacyBytes).lastUnreadSequence).toBeUndefined();
  expect(fromBinary(AgentUnreadSummaryEntrySchema, newBytes).lastUnreadSequence).toBe(12n);
});

test("start decoder preserves only positive safe sequence proofs with matching scope", () => {
  const valid = { ...start, lastUnreadSequences: { "#alpha": Number.MAX_SAFE_INTEGER } };
  const bytes = encodeAgentStartIntent(valid);
  expect(decodeAgentStartIntent(bytes).lastUnreadSequences).toEqual(valid.lastUnreadSequences);
  expect(decodeAgentStartIntent(encodeAgentStartIntent(start))).not.toHaveProperty(
    "lastUnreadSequences",
  );
  const message = fromBinary(AgentStartIntentSchema, bytes);
  const entry = message.unreadSummary[0]!;
  for (const invalid of [
    { ...entry, lastUnreadSequence: 0n },
    { ...entry, lastUnreadSequence: 1n },
    { ...entry, lastUnreadSequence: 9007199254740992n },
    { ...entry, conversationId: undefined },
    { ...entry, conversationId: " " },
  ]) {
    message.unreadSummary = [invalid];
    const decoded = decodeAgentStartIntent(toBinary(AgentStartIntentSchema, message));
    expect(decoded.unreadSummary).toEqual(start.unreadSummary);
    expect(decoded).not.toHaveProperty("lastUnreadSequences");
  }
});

test("start encoder omits an invalid or unscoped proof", () => {
  const invalidIntents: AgentStartIntent[] = [
    { ...start, lastUnreadSequences: { "#alpha": 0 } },
    { ...start, lastUnreadSequences: { "#alpha": 2.5 } },
    { ...start, lastUnreadSequences: { "#alpha": 1 } },
    { ...start, lastUnreadSequences: { "#alpha": Number.MAX_SAFE_INTEGER + 1 } },
    { ...start, lastUnreadSequences: { "#beta": 12 } },
    { ...start, unreadConversationIds: {}, lastUnreadSequences: { "#alpha": 12 } },
  ];
  for (const intent of invalidIntents) {
    const { unreadSummary } = fromBinary(AgentStartIntentSchema, encodeAgentStartIntent(intent));
    expect(unreadSummary[0]?.lastUnreadSequence).toBeUndefined();
  }
});
