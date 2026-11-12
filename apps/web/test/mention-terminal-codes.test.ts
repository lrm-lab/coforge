import { expect, test } from "bun:test";
import { MENTION_DELIVERY_TERMINAL_CODES } from "@lrm/coforge-sdk/internal";
import { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";

/** A Computer, Workspace, Agent and launch that agree with each other, so no report is read as a
 * drift and every code reaches the settlement table. */
const COMPUTER = "computer-1";
const ENVELOPE = {
  messageId: "message-1",
  launchId: "launch-1",
  sessionId: "session-1",
  computerId: COMPUTER,
};

/** The service with a repository that only records what a terminal error settles as. */
function subject() {
  const settled: { code: string; outcome: string; reason: string | null }[] = [];
  const repository = {
    settleTerminal: async (
      _key: unknown,
      settle: { code: string; outcome: string; reason: string | null },
    ) => {
      settled.push(settle);
    },
  };
  const reports = new MentionDeliveryReports(
    repository as never,
    { publishBatch: async () => {} } as never,
    {} as never,
  );
  const terminal = async (code: string) => {
    await reports.receiveTerminalError(
      {
        protocolMajor: 1,
        requestId: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        code,
        mentionDelivery: ENVELOPE,
      },
      COMPUTER,
    );
    return settled.at(-1);
  };
  return { terminal };
}

test("a spent startup deadline settles the mention lost as not launched, keeping its code", async () => {
  const { terminal } = subject();
  // The code is what makes the settlement final: `settleableByAck` only lets a not-launched row
  // through when no code came with it (task #33).
  expect(await terminal(MENTION_DELIVERY_TERMINAL_CODES.STARTUP_DEADLINE_EXCEEDED)).toEqual({
    code: MENTION_DELIVERY_TERMINAL_CODES.STARTUP_DEADLINE_EXCEEDED,
    outcome: "lost",
    reason: "not_launched",
  });
});

test("a code this server does not know still settles the mention, as unclassified", async () => {
  const { terminal } = subject();
  expect(await terminal("FROM_A_NEWER_DAEMON")).toEqual({
    code: "FROM_A_NEWER_DAEMON",
    outcome: "lost",
    reason: "unclassified",
  });
});

test("the rate-limit and rejection codes keep their own categories", async () => {
  const { terminal } = subject();
  expect(await terminal(MENTION_DELIVERY_TERMINAL_CODES.QUOTA_LIMITED)).toMatchObject({
    outcome: "lost",
    reason: "quota",
  });
  expect(await terminal(MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED)).toMatchObject({
    outcome: "lost",
    reason: "runtime_error",
  });
});
