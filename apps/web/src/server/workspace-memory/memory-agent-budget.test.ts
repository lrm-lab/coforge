import { expect, test } from "bun:test";
import { MEMORY_OFFER_BUDGET_PER_TRIGGER, OPENVIKING_AGENT_PROTOCOL } from "@lrm/coforge-sdk/agent";
import {
  createMemoryAgentBudgetLedger,
  MemoryAgentBudgetError,
  MemoryAgentTriggerBudget,
} from "./memory-agent-budget";

const ovFind = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "fork_find" as const,
  operationId: "f1",
  query: "deploy",
};

const offer = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "offer" as const,
  operationId: "o1",
  conversationId: "c",
  targetAgentId: "a",
  recipientRationale: "owns the task",
  citationRefs: ["ov:1"],
  body: "cited offer",
};

test("Web budget consumes C2 constants rather than copied literals", () => {
  expect(MEMORY_OFFER_BUDGET_PER_TRIGGER).toBe(1);
});

test("allows further reads and still rejects a second Offer", () => {
  const openviking = new MemoryAgentTriggerBudget();
  openviking.consume(ovFind);
  openviking.consume({ ...ovFind, operationId: "f2" });
  openviking.consume({ ...ovFind, operationId: "f3" });
  expect(() => openviking.consume({ ...ovFind, operationId: "f4" })).not.toThrow();
  expect(openviking.snapshot()).toEqual({ reads: 4, offers: 0 });

  const offers = new MemoryAgentTriggerBudget();
  offers.consume(offer);
  expect(() => offers.consume({ ...offer, operationId: "o2" })).toThrow(MemoryAgentBudgetError);
});

test("search_context counts reads without a per-trigger cap or token pool", () => {
  const budget = new MemoryAgentTriggerBudget();
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  expect(budget.consume(searchContext)).toBeUndefined();
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 0 });
  budget.consume({ ...searchContext, operationId: "c2" });
  budget.consume({ ...searchContext, operationId: "c3" });
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).not.toThrow();
  expect(budget.snapshot()).toEqual({ reads: 4, offers: 0 });
});

test("ledger isolates budget by Workspace, Memory Agent, and triggering Message", () => {
  const ledger = createMemoryAgentBudgetLedger();
  const first = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
  });
  first.consume(ovFind);
  first.consume(offer);
  const same = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-1",
  });
  expect(() => same.consume({ ...offer, operationId: "o2" })).toThrow(MemoryAgentBudgetError);
  const nextTrigger = ledger.forTrigger({
    workspaceId: "ws-a",
    agentId: "mem-1",
    triggerMessageId: "msg-2",
  });
  expect(nextTrigger.consume({ ...ovFind, operationId: "f-next" })).toBeUndefined();
  expect(nextTrigger.consume({ ...offer, operationId: "o-next" })).toBeUndefined();
});

test("only the acquired request can release a rejected Offer, while unknown permits identical recovery", () => {
  const budget = new MemoryAgentTriggerBudget();
  const first = budget.acquireOffer(offer);
  expect(() => budget.acquireOffer(offer)).toThrow("pending");
  first(); // no publication outcome: keep the slot
  expect(() => budget.acquireOffer({ ...offer, operationId: "other" })).toThrow(
    MemoryAgentBudgetError,
  );
  const retry = budget.acquireOffer(offer);
  retry({ phase: "rejected_before_publish" });
  expect(budget.snapshot().offers).toBe(0);
  const next = budget.acquireOffer({ ...offer, operationId: "other" });
  first({ phase: "rejected_before_publish" }); // late/duplicate completion
  expect(budget.snapshot().offers).toBe(1);
  next({ phase: "published", messageId: "message" });
  const publishedRetry = budget.acquireOffer({ ...offer, operationId: "other" });
  publishedRetry({ phase: "rejected_before_publish" });
  expect(budget.snapshot().offers).toBe(1);
});
