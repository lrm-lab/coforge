import { expect, test } from "bun:test";
import { deriveTurnEnrichment, evaluatorResultFromVerdict } from "../src/enrichment";

const m1 = "0197aaaa-bbbb-7ccc-8ddd-000000000001";
const m2 = "0197aaaa-cccc-7ccc-8ddd-000000000002";
const decision = (agentId: string, messageId: string, outcome: "notified" | "held") => ({
  at: "t",
  agentId,
  messageId,
  deliveryId: "d",
  target: "#t",
  sequence: 1,
  outcome,
});

test("derives tool exchanges for the sender and delivery facts for the others", () => {
  const result = deriveTurnEnrichment({
    messages: [
      { id: m1, senderAgentId: null },
      { id: m2, senderAgentId: "a-task" },
    ],
    agents: [
      {
        id: "a-task",
        name: "task",
        trace: {
          sessionId: "s",
          sends: [
            {
              messageId: m2,
              toolExchanges: [
                { toolCallId: "c", toolName: "bash", input: {}, output: "x", isError: false },
              ],
              receivedShortIds: [m1.slice(0, 13)],
            },
          ],
          trailingReceivedShortIds: [],
        },
        decisions: [decision("a-task", m1, "notified")],
      },
      { id: "a-mem", name: "memory", trace: null, decisions: [decision("a-mem", m2, "held")] },
    ],
  });
  expect(result.get(m2)?.toolExchanges?.[0]?.toolCallId).toBe("c");
  expect(result.get(m1)?.deliveries).toEqual([
    { participantId: "coforge__task", notified: true, read: true },
  ]);
  expect(result.has(m2) && result.get(m2)?.deliveries).toBeFalsy();
});

test("only a graded verdict with a reward becomes evaluator evidence", () => {
  const pass = evaluatorResultFromVerdict({
    episodeId: "e1",
    verdict: { graded: true, reward: 0.7, feedback: " KEY FINDINGS " },
    passReward: 0.6,
  });
  expect(pass[0]).toMatchObject({
    signal: "pass",
    reward: 0.7,
    feedback: "KEY FINDINGS",
    signalKind: "evaluator",
  });
  expect(
    evaluatorResultFromVerdict({
      episodeId: "e1",
      verdict: { graded: true, reward: 0.2 },
      passReward: 0.6,
    })[0]?.signal,
  ).toBe("fail");
  expect(
    evaluatorResultFromVerdict({
      episodeId: "e1",
      verdict: { graded: false, reward: 0.9 },
      passReward: 0.6,
    }),
  ).toEqual([]);
  expect(
    evaluatorResultFromVerdict({ episodeId: "e1", verdict: { graded: true }, passReward: 0.6 }),
  ).toEqual([]);
});
