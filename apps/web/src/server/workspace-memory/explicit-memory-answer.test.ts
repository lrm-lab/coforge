import { expect, test } from "bun:test";
import {
  channelSendNeedsMemoryOffer,
  isExplicitMemoryDiagnosis,
  fifoOldestUnansweredQuestion,
  isExplicitMemoryQuestion,
  pickObserverOfferTarget,
  explicitMemoryQuestionRequiresOffer,
} from "./explicit-memory-answer";
import {
  clearNoCardAllowance,
  recordMemoryRetrieval,
} from "./no-card-allowance";

test("an explicit @memory question is a token, not a substring", () => {
  expect(isExplicitMemoryQuestion("@memory When did Caroline go?")).toBe(true);
  expect(isExplicitMemoryQuestion("please @memory the date")).toBe(true);
  expect(isExplicitMemoryQuestion("email me@memory.example")).toBe(false);
  expect(isExplicitMemoryQuestion("Caroline went to the group")).toBe(false);
  expect(
    isExplicitMemoryQuestion(
      "<@agent:40892ec7-004d-4a0c-89bf-ed4e2e79ab0e> When did Caroline go?",
      "40892ec7-004d-4a0c-89bf-ed4e2e79ab0e",
    ),
  ).toBe(true);
  expect(
    isExplicitMemoryQuestion(
      "<@agent:other> When did Caroline go?",
      "40892ec7-004d-4a0c-89bf-ed4e2e79ab0e",
    ),
  ).toBe(false);
});

test("a later question may still be answered after an earlier offer", () => {
  const earlier = new Date("2026-09-22T09:00:00.000Z");
  const laterQuestion = new Date("2026-09-22T09:05:00.000Z");
  expect(
    channelSendNeedsMemoryOffer({
      latestQuestionAt: laterQuestion,
      latestOfferAt: earlier,
    }),
  ).toBe(true);
  expect(
    channelSendNeedsMemoryOffer({
      latestQuestionAt: earlier,
      latestOfferAt: laterQuestion,
    }),
  ).toBe(false);
  expect(
    channelSendNeedsMemoryOffer({
      latestQuestionAt: null,
      latestOfferAt: null,
    }),
  ).toBe(false);
});

test("FIFO binding answers the oldest unanswered question under a backlog", () => {
  const q1 = { id: "q1", createdAt: new Date("2026-09-23T02:40:00.000Z") };
  const q2 = { id: "q2", createdAt: new Date("2026-09-23T02:41:00.000Z") };
  const q3 = { id: "q3", createdAt: new Date("2026-09-23T02:42:00.000Z") };
  const t = (iso: string) => new Date(iso);

  // No offers yet: the oldest question is the binding target.
  expect(fifoOldestUnansweredQuestion([q2, q3], [])?.id).toBe("q2");

  // One offer after q1 only: q1 is answered, the next oldest (q2) binds.
  expect(
    fifoOldestUnansweredQuestion([q1, q2, q3], [t("2026-09-23T02:40:30.000Z")])
      ?.id,
  ).toBe("q2");

  // Backlog cascade guard: an offer after BOTH q1 and q2 still answers only
  // one question — the oldest unanswered one before it.
  expect(
    fifoOldestUnansweredQuestion([q1, q2, q3], [t("2026-09-23T02:42:30.000Z")])
      ?.id,
  ).toBe("q2");

  // Orphan offers (before every question, or duplicate within one gap) answer nothing.
  expect(
    fifoOldestUnansweredQuestion([q1, q2], [t("2026-09-23T02:30:00.000Z")])?.id,
  ).toBe("q1");
  expect(
    fifoOldestUnansweredQuestion(
      [q1, q2],
      [t("2026-09-23T02:40:10.000Z"), t("2026-09-23T02:40:20.000Z")],
    )?.id,
  ).toBe("q2");

  // Everything answered: no target.
  expect(
    fifoOldestUnansweredQuestion(
      [q1, q2],
      [t("2026-09-23T02:40:10.000Z"), t("2026-09-23T02:41:10.000Z")],
    ),
  ).toBeNull();
  expect(fifoOldestUnansweredQuestion([], [])).toBeNull();
});

test("diagnosis requires explicit intent addressed to the designated memory identity", () => {
  const id = "40892ec7-004d-4a0c-89bf-ed4e2e79ab0e";
  expect(isExplicitMemoryDiagnosis("@memory diagnose search failure", id)).toBe(
    true,
  );
  expect(
    isExplicitMemoryDiagnosis(`<@agent:${id}> diagnose search failure`, id),
  ).toBe(true);
  expect(isExplicitMemoryDiagnosis("@memory retrieve search history", id)).toBe(
    false,
  );
  expect(isExplicitMemoryDiagnosis("@memory something looks wrong", id)).toBe(
    false,
  );
  expect(
    isExplicitMemoryDiagnosis("<@agent:another> diagnose failure", id),
  ).toBe(false);
});

test("observer mode: an Offer goes to the Agent the latest message addressed, never to Memory itself", () => {
  const mem = "mem-1";
  expect(pickObserverOfferTarget(null, mem, "peer")).toBeNull();
  expect(
    pickObserverOfferTarget(
      {
        conversationId: "c1",
        mentionedAgentIds: [mem, "task-1"],
        senderAgentId: null,
      },
      mem,
      null,
    ),
  ).toEqual({ conversationId: "c1", targetAgentId: "task-1" });
  expect(
    pickObserverOfferTarget(
      { conversationId: "c1", mentionedAgentIds: [], senderAgentId: "task-2" },
      mem,
      null,
    ),
  ).toEqual({ conversationId: "c1", targetAgentId: "task-2" });
  expect(
    pickObserverOfferTarget(
      { conversationId: "c1", mentionedAgentIds: [], senderAgentId: null },
      mem,
      "peer",
    ),
  ).toEqual({ conversationId: "c1", targetAgentId: "peer" });
  expect(
    pickObserverOfferTarget(
      { conversationId: "c1", mentionedAgentIds: [mem], senderAgentId: mem },
      mem,
      null,
    ),
  ).toBeNull();
});

test("no-card allowance lets one plain Memory message through an unanswered @memory question", async () => {
  const input = {
    workspaceId: "ws-q",
    agentId: "mem-q",
    conversationId: "c-q",
  };
  const db = {
    message: {
      findMany: async () => [
        {
          body: "@task @memory write it",
          createdAt: new Date("2026-10-24T05:00:00.000Z"),
          conversationId: "c-q",
          sender: { agentId: null },
        },
      ],
    },
    memoryOfferRecord: { findMany: async () => [] },
  } as never;
  const designated = async () => true;
  clearNoCardAllowance(input.workspaceId, input.agentId);
  // Unanswered question, nothing retrieved yet: a plain message is still refused.
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  // Retrieval came back empty: the plain "no applicable card" message may pass...
  recordMemoryRetrieval(input.workspaceId, input.agentId, 0);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    false,
  );
  // ...and after it was sent the rule is back in force.
  clearNoCardAllowance(input.workspaceId, input.agentId);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  // A retrieval with hits never grants the allowance.
  recordMemoryRetrieval(input.workspaceId, input.agentId, 3);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  // The allowance expires.
  recordMemoryRetrieval(
    input.workspaceId,
    input.agentId,
    0,
    Date.now() - 11 * 60_000,
  );
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
});

test("retrieval with items but none applicable: the second plain message passes once", async () => {
  const input = {
    workspaceId: "ws-r",
    agentId: "mem-r",
    conversationId: "c-r",
  };
  const db = {
    message: {
      findMany: async () => [
        {
          body: "@task @memory write it",
          createdAt: new Date("2026-10-24T05:00:00.000Z"),
          conversationId: "c-r",
          sender: { agentId: null },
        },
      ],
    },
    memoryOfferRecord: { findMany: async () => [] },
  } as never;
  const designated = async () => true;
  clearNoCardAllowance(input.workspaceId, input.agentId);
  recordMemoryRetrieval(input.workspaceId, input.agentId, 4);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    false,
  );
  // After that message went out the rule is back (counters reset)...
  clearNoCardAllowance(input.workspaceId, input.agentId);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  // ...and a new retrieval starts a new count.
  recordMemoryRetrieval(input.workspaceId, input.agentId, 2);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    false,
  );
  // No retrieval at all never grants anything.
  clearNoCardAllowance(input.workspaceId, input.agentId);
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
  expect(await explicitMemoryQuestionRequiresOffer(db, input, designated)).toBe(
    true,
  );
});
