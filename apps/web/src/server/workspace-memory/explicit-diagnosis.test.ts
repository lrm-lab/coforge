import { expect, test } from "bun:test";
import { createExplicitMemoryDiagnosis } from "./explicit-diagnosis";

test("diagnosis waits for all four roles and publishes only the completed report to the requesting agent", async () => {
  let ready = false;
  const delivered: unknown[] = [];
  const diagnose = createExplicitMemoryDiagnosis({
    async resolve() {
      return {
        requestId: "request-1",
        conversationId: "channel",
        targetAgentId: "requester",
        question: "diagnose",
        messages: [],
      };
    },
    async run() {
      return ready
        ? {
            status: "completed" as const,
            report: { report: { reason: "Wrong branch", decisive_ao_refs: [1] } },
            report_uri: "viking://report",
            content_hash: "hash",
          }
        : { status: "running" as const };
    },
    async publish(input) {
      delivered.push(input);
      return { duplicate: delivered.length > 1, messageId: "answer" };
    },
  });
  const input = {
    workspaceId: "workspace",
    agentId: "memory",
    messageId: "request",
    operationId: "operation",
  };
  expect((await diagnose(input)).status).toBe("running");
  expect(delivered).toEqual([]);
  ready = true;
  expect(await diagnose(input)).toMatchObject({
    status: "completed",
    published: true,
    messageId: "answer",
  });
  expect(delivered[0]).toMatchObject({
    scope: { targetAgentId: "requester", conversationId: "channel" },
  });
});

test("unavailable or unauthorized evidence never starts construction or publishes", async () => {
  let called = false;
  const diagnose = createExplicitMemoryDiagnosis({
    async resolve() {
      throw new Error("diagnosis_scope_denied");
    },
    async run() {
      called = true;
      return { status: "running" };
    },
    async publish() {
      called = true;
      return { duplicate: false, messageId: "bad" };
    },
  });
  await expect(
    diagnose({ workspaceId: "w", agentId: "m", messageId: "q", operationId: "op" }),
  ).rejects.toThrow("diagnosis_scope_denied");
  expect(called).toBe(false);
});

test("failed Reader reports notify the requester without publishing a successful Hint", async () => {
  const notices: unknown[] = [];
  const diagnose = createExplicitMemoryDiagnosis({
    async resolve() {
      return {
        requestId: "q",
        conversationId: "c",
        targetAgentId: "t",
        question: "q",
        messages: [],
      };
    },
    async run() {
      return { status: "failed", reason: "reader_incomplete" };
    },
    async notifyFailure(input) {
      notices.push(input);
      return "failure-notice";
    },
    async publish() {
      throw new Error("must not publish");
    },
  });
  expect(
    await diagnose({ workspaceId: "w", agentId: "m", messageId: "q", operationId: "op" }),
  ).toMatchObject({
    status: "failed",
    reason: "reader_incomplete",
    published: false,
    messageId: "failure-notice",
  });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ scope: { targetAgentId: "t", conversationId: "c" } });
});
