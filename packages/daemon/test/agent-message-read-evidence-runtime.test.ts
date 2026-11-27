import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageRequest } from "@lrm/coforge-sdk/internal";
import type { AgentMessageTransportResponse } from "#src/connection/agent-http-clients";
import { createMessageHarness } from "./fixtures/message-harness";
import { messageRecord, readScope } from "./fixtures/message-record";

const workspaceRoot = await mkdtemp(join(realpathSync(tmpdir()), "coforge-daemon-read-evidence-"));
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
const openHarness = createMessageHarness({
  connection: { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot },
  config: { provider: "pi", model: "default", modelProvider: "anthropic", reasoning: "balanced" },
});
const messageHarness = (respond: Parameters<typeof openHarness>[0]) =>
  openHarness(
    respond,
    undefined,
    undefined,
    undefined,
    undefined,
    join(workspaceRoot, crypto.randomUUID()),
  );

describe("the Agent read boundary (exact seen sequences)", () => {
  type Harness = Awaited<ReturnType<typeof messageHarness>>;
  type Respond = Parameters<typeof messageHarness>[0];
  const sent = (request: AgentMessageRequest): AgentMessageTransportResponse => ({
    idempotencyKey: request.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messageId: "sent",
    messages: [],
    state: "sent",
    decision: "forward",
  });
  const page = (
    request: AgentMessageRequest,
    messages: ReturnType<typeof messageRecord>[],
    fields: Partial<AgentMessageTransportResponse> = {},
  ): AgentMessageTransportResponse => ({
    idempotencyKey: request.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    hasMore: false,
    ...(request.operation === "read"
      ? { consumptionScope: readScope(request.agentId, request.target) }
      : {}),
    messages,
    ...fields,
  });
  const harnessWithSends = async (respond: Respond) => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation !== "send") return respond(request);
      sends.push(request);
      return sent(request);
    });
    return { harness, sends };
  };
  const run = (
    harness: Harness,
    idempotencyKey: string,
    fields: Omit<
      import("@lrm/coforge-sdk/internal").LocalAgentMessageRequest,
      "idempotencyKey" | "context"
    >,
  ) =>
    harness.runtime.agentMessage(
      harness.context,
      { idempotencyKey, context: harness.context, ...fields },
      harness.apiKey,
    );
  const readExact = (harness: Harness) =>
    run(harness, "around", { operation: "read", target: "@ada", around: "abcdef12" });
  test("only the scoped anchored read contributes exact sequences above the frontier", async () => {
    const { harness, sends } = await harnessWithSends(async (request) => {
      if (request.operation === "check")
        return page(request, [messageRecord(6, "@ada", "@ada"), messageRecord(8, "@ada", "@ada")]);
      if (request.around)
        return page(
          request,
          [messageRecord(10, "@ada", "@ada"), messageRecord(11, "@ada", "@ada")],
          {
            modelSeenUpToSeq: 11,
          },
        );
      return page(request, [messageRecord(3, "@ada", "@ada")], { modelSeenUpToSeq: 4 });
    });
    try {
      await run(harness, "read", { operation: "read", target: "@ada" });
      const checked = await run(harness, "check", { operation: "check" });
      expect(checked.messages.map(({ sequence }) => sequence)).toEqual([6, 8]);
      await readExact(harness);
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        consumptionEvidence: [
          {
            target: { conversationId: "conversation-a" },
            entry: { seq: 4, exactSeqs: [10, 11] },
          },
        ],
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a send reports at most the newest 2500 exact sequences", async () => {
    const shown = Array.from({ length: 2600 }, (_, index) =>
      messageRecord(index + 1, "@ada", "@ada"),
    );
    const { harness, sends } = await harnessWithSends(async (request) => page(request, shown));
    try {
      await readExact(harness);
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      const exact = sends[0]?.seenExactSeqs ?? [];
      expect(sends[0]?.seenUpToSeq).toBeUndefined();
      expect(exact).toHaveLength(2500);
      expect([exact[0], exact.at(-1)]).toEqual([101, 2600]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("the server's model-seen boundary advances the frontier", async () => {
    const { harness, sends } = await harnessWithSends(async (request) =>
      page(request, [messageRecord(5, "@ada", "@ada")], { modelSeenUpToSeq: 7 }),
    );
    try {
      await run(harness, "read", { operation: "read", target: "@ada" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      expect(sends[0]?.seenUpToSeq).toBe(7);
      expect(sends[0]?.seenExactSeqs).toBeUndefined();
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a read without a model-seen boundary moves no frontier: the daemon infers none", async () => {
    const { harness, sends } = await harnessWithSends(async (request) =>
      page(request, [messageRecord(5, "@ada", "@ada")]),
    );
    try {
      await run(harness, "read", { operation: "read", target: "@ada" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      expect(sends[0]?.seenUpToSeq).toBeUndefined();
      expect(sends[0]?.seenExactSeqs).toEqual([5]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an accepted send cannot replace exact read evidence with a frontier", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return page(request, [messageRecord(6, "@ada", "@ada"), messageRecord(8, "@ada", "@ada")]);
      sends.push(request);
      return sends.length === 1
        ? {
            ...sent(request),
            reason: "exact_target_pending_already_seen",
            writeConsumptionScope: { conversationId: "conversation-a" },
            seenUpToSeq: 8,
          }
        : sent(request);
    });
    try {
      await harness.deliver(6, "@ada");
      await harness.deliver(8, "@ada");
      await readExact(harness);
      await run(harness, "send", { operation: "send", target: "@ada", content: "one" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "two" });
      expect(sends[0]).toMatchObject({ seenExactSeqs: [6, 8] });
      expect(sends[1]?.seenUpToSeq).toBeUndefined();
      expect(sends[1]?.seenExactSeqs).toEqual([6, 8]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a send receipt without scope cannot advance the target's read evidence", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return page(request, [messageRecord(6, "@ada", "@ada")], { modelSeenUpToSeq: 6 });
      sends.push(request);
      return sends.length === 1 ? { ...sent(request), seenUpToSeq: 31 } : sent(request);
    });
    try {
      await run(harness, "read", { operation: "read", target: "@ada" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "one" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "two" });
      expect(sends[1]).toMatchObject({
        consumptionEvidence: [
          {
            target: { conversationId: "conversation-a" },
            entry: { seq: 6 },
          },
        ],
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a locally held draft waits for an explicit read of the pending message", async () => {
    const { harness, sends } = await harnessWithSends(async (request) =>
      request.around
        ? page(request, [messageRecord(7, "@ada", "@ada")])
        : page(request, [messageRecord(5, "@ada", "@ada")], { modelSeenUpToSeq: 5 }),
    );
    try {
      await harness.deliver(5, "@ada");
      await harness.deliver(7, "@ada");
      await readExact(harness);
      const held = await run(harness, "send", { operation: "send", target: "@ada", content: "x" });
      expect(sends).toHaveLength(0);
      expect(held).toMatchObject({ state: "held", decision: "local_hold" });
      expect(held.messages.map(({ sequence }) => sequence)).toEqual([5]);
      const stillHeld = await run(harness, "still-held", {
        operation: "send",
        target: "@ada",
        sendDraft: true,
      });
      expect(stillHeld.state).toBe("held");
      expect(sends).toHaveLength(0);
      await run(harness, "read-pending", { operation: "read", target: "@ada" });
      const resent = await run(harness, "resend", {
        operation: "send",
        target: "@ada",
        sendDraft: true,
      });
      expect(resent.state).toBe("sent");
      expect(sends[0]?.seenUpToSeq).toBe(5);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a read the server does not call contiguous records exact sequences, not a frontier", async () => {
    const { harness, sends } = await harnessWithSends(async (request) =>
      page(request, [messageRecord(2, "@ada", "@ada"), messageRecord(3, "@ada", "@ada")], {
        modelSeenUpToSeq: null,
        hasOlder: true,
      }),
    );
    try {
      await run(harness, "older", { operation: "read", target: "@ada", before: "abcdef12" });
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      expect(sends[0]?.seenUpToSeq).toBeUndefined();
      expect(sends[0]?.seenExactSeqs).toEqual([2, 3]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a held send keeps exact read evidence in the draft", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read") return page(request, [messageRecord(6, "@ada", "@ada")]);
      sends.push(request);
      if (sends.length > 1) return sent(request);
      return {
        idempotencyKey: request.idempotencyKey,
        accepted: false,
        attentionCount: 1,
        state: "held",
        decision: "local_hold",
        reason: "exact_target_pending",
        newMessageCount: 1,
        shownMessageCount: 1,
        omittedMessageCount: 0,
        writeConsumptionScope: { conversationId: "conversation-a" },
        seenUpToSeq: 8,
        messages: [messageRecord(8, "@ada", "@ada")],
      };
    });
    try {
      await readExact(harness);
      await run(harness, "send", { operation: "send", target: "@ada", content: "reply" });
      await run(harness, "resend", { operation: "send", target: "@ada", sendDraft: true });
      expect(sends[0]).toMatchObject({ seenExactSeqs: [6] });
      expect(sends[1]?.seenUpToSeq).toBeUndefined();
      expect(sends[1]?.seenExactSeqs).toEqual([6]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test.each([
    [
      "a read's consumption scope settles a pending notice delivered under another spelling",
      "agent-a",
      0,
    ],
    ["a consumption scope for another Agent is not the read's to apply", "agent-b", 1],
  ] as const)("%s", async (_, agentId, pending) => {
    const { harness } = await harnessWithSends(async (request) =>
      request.operation === "check"
        ? page(request, [])
        : page(request, [messageRecord(5, "@ada", "@ada")], {
            modelSeenUpToSeq: 5,
            consumptionScope: {
              agentId,
              conversationId: "conversation-a",
              channelType: "dm",
              target: "@ada",
            },
          }),
    );
    try {
      await harness.deliver(5, "@Ada");
      await run(harness, "read", { operation: "read", target: "@ada" });
      const checked = await run(harness, "check", { operation: "check" });
      expect(checked.attentionCount).toBe(pending);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a target spelled another way shares the consumed state the server's scope names", async () => {
    const spelled = "#general:0F0E0D0C-0B0A-4908-8706-050403020100";
    const canonical = spelled.toLowerCase();
    const { harness, sends } = await harnessWithSends(async (request) =>
      page(request, [messageRecord(9, "@ada", canonical)], {
        modelSeenUpToSeq: 9,
        consumptionScope: {
          agentId: "agent-a",
          conversationId: "conversation-a",
          channelType: "thread",
          target: canonical,
          threadRootId: canonical.slice("#general:".length),
        },
      }),
    );
    try {
      await run(harness, "read", { operation: "read", target: spelled });
      await run(harness, "send", { operation: "send", target: spelled, content: "reply" });
      expect(sends[0]).toMatchObject({
        target: canonical,
        consumptionEvidence: [
          {
            target: {
              conversationId: "conversation-a",
              threadRootId: canonical.slice("#general:".length),
            },
            entry: { seq: 9 },
          },
        ],
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("recentUnread from a bypassed hold is returned without advancing modelSeen", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation !== "send")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [],
        };
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messageId: "sent-1",
          messages: [],
          state: "sent",
          decision: "bypass",
          recentUnread: [messageRecord(11, "@bea", "@ada")],
          writeConsumptionScope: { conversationId: "conversation-a" },
        };
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent-2",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      const result = await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "anyway-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "reply",
          continueAnyway: true,
        },
        harness.apiKey,
      );
      expect(result.recentUnread?.map((m) => m.id)).toEqual(["message-11"]);
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "follow-up-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "follow up",
        },
        harness.apiKey,
      );
      expect(sends[1]?.seenUpToSeq).toBeUndefined();
      expect(sends[1]).toHaveProperty("consumptionEvidence", undefined);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("uses the full target and short-read position when sending to a short thread target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: request.operation === "read" ? [messageRecord(7, "@ada", fullTarget)] : [],
        ...(request.operation === "read"
          ? {
              modelSeenUpToSeq: 7,
              consumptionScope: { ...readScope(request.agentId, fullTarget), threadRootId: rootId },
            }
          : {}),
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-short",
          context: harness.context,
          operation: "read",
          target: "@ada:12345678",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "send-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          content: "reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
        seenUpToSeq: 7,
      });
    } finally {
      await harness.runtime.stop();
    }
  });
});
