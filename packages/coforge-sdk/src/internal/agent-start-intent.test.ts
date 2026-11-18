import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentStartIntentSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  AGENT_START_MESSAGE_TYPE,
  decodeAgentStartIntent,
  decodeAgentStartIntentScope,
  encodeAgentStartIntent,
} from "./index";
const base = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex" as const,
  model: "gpt-5",
  reasoning: "medium",
};
test("round-trips launchId on a managed (controlEpoch-carrying) start intent", () => {
  const managed = { ...base, controlEpoch: 3, launchId: "launch-1" };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(managed))).toEqual({
    ...managed,
    modelProvider: "",
    providerConfig: undefined,
  });
});
test("round-trips an unmanaged start intent without launchId or controlEpoch", () => {
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).toEqual({
    ...base,
    modelProvider: "",
    providerConfig: undefined,
  });
});
test("round-trips the Fast mode request, and omits it when not requested", () => {
  const fast = { ...base, fastMode: true };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(fast))).toEqual({
    ...fast,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).not.toHaveProperty("fastMode");
  expect(
    decodeAgentStartIntent(encodeAgentStartIntent({ ...base, fastMode: false })),
  ).not.toHaveProperty("fastMode");
});
test("rejects encoding a managed start intent with no launchId", () => {
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1 })).toThrow("launchId");
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1, launchId: "  " })).toThrow(
    "launchId",
  );
});
test("rejects decoding a managed start intent with no launchId", () => {
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      controlEpoch: 1,
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("launchId");
});
test("rejects an oversized launchId on encode and decode", () => {
  const oversized = "x".repeat(513);
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1, launchId: oversized })).toThrow(
    "invalid Agent start launchId",
  );
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      controlEpoch: 1,
      launchId: oversized,
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("invalid agent start intent launchId");
});
test("round-trips a resume prompt, which replaces every recovery field", () => {
  const resumed = { ...base, resumePrompt: "Stop editing the schema; only the frontend." };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(resumed))).toEqual({
    ...resumed,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(() => encodeAgentStartIntent({ ...resumed, unreadSummary: { "#general": 1 } })).toThrow(
    "resume prompt",
  );
});
test("rejects a blank or oversized resume prompt on encode and decode", () => {
  expect(() => encodeAgentStartIntent({ ...base, resumePrompt: "  " })).toThrow("resume prompt");
  expect(() => encodeAgentStartIntent({ ...base, resumePrompt: "x".repeat(8193) })).toThrow(
    "resume prompt",
  );
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      resumePrompt: "x".repeat(8193),
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("resume prompt");
});
test("rejects decoding a resume prompt that also carries message recovery", () => {
  const recovery = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 1n,
    target: "#general",
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "hello",
  };
  for (const carried of [{ wakeMessage: recovery }, { resumeMessages: [recovery] }]) {
    const encoded = toBinary(
      AgentStartIntentSchema,
      create(AgentStartIntentSchema, {
        ...base,
        messageType: AGENT_START_MESSAGE_TYPE,
        resumePrompt: "Only the frontend.",
        ...carried,
      }),
    );
    expect(() => decodeAgentStartIntent(encoded)).toThrow("resume prompt");
  }
});
test("a task conversation target round-trips through start recovery", () => {
  const message = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 4,
    target: "#coforge:#100",
    latestSenderKind: "human" as const,
    latestSenderHandle: "frank",
    latestSenderDescription: "",
    body: "status?",
  };
  const decoded = decodeAgentStartIntent(
    encodeAgentStartIntent({
      ...base,
      resumeMessages: [message],
      unreadSummary: { "#coforge:#100": 1, "dm:@ada~human:#3": 1 },
    }),
  );
  expect(decoded.resumeMessages?.[0]?.target).toBe("#coforge:#100");
  expect(decoded.unreadSummary).toEqual({ "#coforge:#100": 1, "dm:@ada~human:#3": 1 });
  expect(
    decodeAgentStartIntent(
      encodeAgentStartIntent({
        ...base,
        resumeMessages: [{ ...message, target: "#general:12345678" }],
      }),
    ).resumeMessages?.[0]?.target,
  ).toBe("#general:12345678");
  for (const target of ["#general:reply-id", "attachment:12345678-1234-4234-8234-123456789abc"])
    expect(() =>
      decodeAgentStartIntent(
        encodeAgentStartIntent({
          ...base,
          resumeMessages: [{ ...message, target }],
        }),
      ),
    ).toThrow("invalid agent recovery context");
});

test("encoding refuses a target this boundary never accepts, as decoding does", () => {
  const message = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 4,
    target: "@ada",
    latestSenderKind: "human" as const,
    latestSenderHandle: "frank",
    latestSenderDescription: "",
    body: "status?",
  };
  const attachment = "attachment:12345678-1234-4234-8234-123456789abc";
  expect(() =>
    encodeAgentStartIntent({ ...base, resumeMessages: [{ ...message, target: attachment }] }),
  ).toThrow("invalid agent recovery context");
  expect(() => encodeAgentStartIntent({ ...base, unreadSummary: { [attachment]: 1 } })).toThrow(
    "invalid agent recovery context",
  );
  expect(
    decodeAgentStartIntent(
      encodeAgentStartIntent({ ...base, resumeMessages: [message], unreadSummary: { "@ada": 1 } }),
    ).unreadSummary,
  ).toEqual({ "@ada": 1 });
});

test("summary recovery carries conversation ids without loading message bodies", () => {
  const intent = {
    ...base,
    unreadSummary: { "#alpha": 200 },
    unreadConversationIds: { "#alpha": "group-alpha" },
  };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent)).unreadConversationIds).toEqual({
    "#alpha": "group-alpha",
  });
});

test("round-trips an introduction prompt, alongside message recovery and a resume prompt", () => {
  const introducing = {
    ...base,
    introductionPrompt: "Introduce yourself to Ada in your direct conversation.",
  };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(introducing))).toEqual({
    ...introducing,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(
    decodeAgentStartIntent(
      encodeAgentStartIntent({ ...introducing, unreadSummary: { "#general": 1 } }),
    ).introductionPrompt,
  ).toBe(introducing.introductionPrompt);
  expect(
    decodeAgentStartIntent(encodeAgentStartIntent({ ...introducing, resumePrompt: "Go on." }))
      .introductionPrompt,
  ).toBe(introducing.introductionPrompt);
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).not.toHaveProperty(
    "introductionPrompt",
  );
});
test("rejects a blank or oversized introduction prompt on encode and decode", () => {
  expect(() => encodeAgentStartIntent({ ...base, introductionPrompt: "  " })).toThrow(
    "introduction prompt",
  );
  expect(() => encodeAgentStartIntent({ ...base, introductionPrompt: "x".repeat(8193) })).toThrow(
    "introduction prompt",
  );
  for (const introductionPrompt of ["", " ", "x".repeat(8193)]) {
    const encoded = toBinary(
      AgentStartIntentSchema,
      create(AgentStartIntentSchema, {
        ...base,
        messageType: AGENT_START_MESSAGE_TYPE,
        introductionPrompt,
      }),
    );
    expect(() => decodeAgentStartIntent(encoded)).toThrow("introduction prompt");
  }
});
test("recovery messages carry when the server created them, and leave it unset otherwise", () => {
  const message = (id: string, createdAtMs?: number) => ({
    messageId: id,
    deliveryId: `delivery-${id}`,
    conversationId: "conversation-1",
    sequence: 1,
    target: "#general",
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "hello",
    ...(createdAtMs === undefined ? {} : { createdAtMs }),
  });
  const intent = {
    ...base,
    wakeMessage: message("a", 1700000000123),
    resumeMessages: [message("b")],
  };
  const decoded = decodeAgentStartIntent(encodeAgentStartIntent(intent));
  expect(decoded.wakeMessage?.createdAtMs).toBe(1700000000123);
  expect(decoded.resumeMessages?.[0] && "createdAtMs" in decoded.resumeMessages[0]).toBe(false);
  expect(() => encodeAgentStartIntent({ ...base, resumeMessages: [message("c", -1)] })).toThrow(
    "invalid Agent recovery creation time",
  );
});
test("round-trips the Agent's config revision on a start intent, and leaves it absent otherwise", () => {
  const revised = { ...base, agentConfigRevision: 7 };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(revised))).toEqual({
    ...revised,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).not.toHaveProperty(
    "agentConfigRevision",
  );
});
test("rejects a start intent whose config revision is not a positive integer", () => {
  for (const agentConfigRevision of [0, -1, 1.5, 2 ** 31, Number.NaN])
    expect(() => encodeAgentStartIntent({ ...base, agentConfigRevision })).toThrow(
      "invalid Agent config revision",
    );
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      agentConfigRevision: 0,
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("invalid Agent config revision");
});
test("a launch carries the model sizes the form filled in, and says nothing when it did not", () => {
  const sized = { ...base, contextWindow: 200000, maxOutputTokens: 64000 };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(sized))).toEqual({
    ...sized,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).not.toHaveProperty("contextWindow");
  expect(() => encodeAgentStartIntent({ ...base, contextWindow: 0 })).toThrow(/out of range/);
  expect(() => encodeAgentStartIntent({ ...base, maxOutputTokens: 10000001 })).toThrow(
    /out of range/,
  );
});

test("a retired Memory Agent launch cannot become an ordinary full-tool Agent", () => {
  const normal = encodeAgentStartIntent(base);
  const profile = new TextEncoder().encode("openviking-memory");
  const legacy = new Uint8Array([...normal, 0xaa, 0x01, profile.length, ...profile]);
  expect(() => decodeAgentStartIntent(legacy)).toThrow("retired Memory Agent");
});

test("encoding refuses every recovery context the Daemon would refuse", () => {
  const message = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 4,
    target: "@ada",
    latestSenderKind: "human" as const,
    latestSenderHandle: "frank",
    latestSenderDescription: "",
    body: "status?",
  };
  const encode = (resumeMessages: (typeof message)[], unreadSummary = {}) =>
    encodeAgentStartIntent({ ...base, resumeMessages, unreadSummary });
  expect(() => encode([{ ...message, conversationId: "" }])).toThrow("recovery context");
  expect(() => encode([{ ...message, latestSenderHandle: "" }])).toThrow("recovery context");
  expect(() => encode([{ ...message, sequence: 0 }])).toThrow("recovery context");
  expect(() => encode([message], { "@ada": 0 })).toThrow("recovery context");
  expect(() =>
    encode(
      Array.from({ length: 101 }, (_, i) => ({
        ...message,
        messageId: `m${i}`,
        deliveryId: `d${i}`,
      })),
    ),
  ).toThrow("recovery context");
});

const rejected = (over: Record<string, unknown> = {}) =>
  toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      controlEpoch: 3,
      launchId: "launch-1",
      unreadSummary: [{ target: "@ada", count: 0 }],
      ...over,
    }),
  );
test("an intent the Daemon refuses as a whole still names the operation it belongs to", () => {
  const bytes = rejected();
  expect(() => decodeAgentStartIntent(bytes)).toThrow();
  expect(decodeAgentStartIntentScope(bytes)).toEqual({
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "codex",
    epoch: 3,
  });
});
test("an intent with no operation to fail yields no scope", () => {
  expect(decodeAgentStartIntentScope(rejected({ controlEpoch: undefined }))).toBeUndefined();
});
test("a scope is refused when any part of it is missing or not a provider", () => {
  for (const over of [
    { agentId: "" },
    { requestId: "" },
    { workspaceId: "" },
    { computerId: "" },
    { provider: "nonsense" },
    { messageType: "something-else" },
    { controlEpoch: 0 },
  ])
    expect(() => decodeAgentStartIntentScope(rejected(over)), JSON.stringify(over)).toThrow();
});
