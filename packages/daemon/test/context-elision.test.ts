import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { elideSeenInContext, reportsCompaction } from "#src/daemon-runtime/context-elision";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const ROLE = "[CoForge current channel role: member; coordinator=none]";

function message(overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    id: crypto.randomUUID(),
    sequence: 1,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "Staff engineer",
    target: "#team",
    body: "hello",
    channelCoordination: ROLE,
    createdAt: "2026-10-30T00:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

async function withLedger(run: (ledger: AgentContextLedger) => void) {
  const root = join(tmpdir(), `coforge-context-elision-${crypto.randomUUID()}`);
  const stateDb = AgentStateDb.open(root, "agent-1");
  try {
    run(new AgentContextLedger(stateDb.database));
  } finally {
    stateDb.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the second message of a sender and of a channel loses the repeated text", () =>
  withLedger((ledger) => {
    const { messages } = elideSeenInContext(
      [message(), message(), message({ target: "#other" })],
      ledger,
    );
    expect(messages.map((m) => m.senderDescription)).toEqual(["Staff engineer", "", ""]);
    expect(messages.map((m) => m.channelCoordination)).toEqual([ROLE, undefined, ROLE]);
  }));

test("a thread shares its channel's role line, and the next output shows nothing new", () =>
  withLedger((ledger) => {
    elideSeenInContext([message()], ledger);
    const { messages } = elideSeenInContext([message({ target: "#team:abcd1234" })], ledger);
    expect(messages[0]).not.toHaveProperty("channelCoordination");
    expect(messages[0]!.senderDescription).toBe("");
  }));

test("a changed description or role line is shown again", () =>
  withLedger((ledger) => {
    elideSeenInContext([message()], ledger);
    const { messages } = elideSeenInContext(
      [
        message({
          senderDescription: "Principal engineer",
          channelCoordination: "[CoForge current channel role: coordinator; coordinator=@ada]",
        }),
      ],
      ledger,
    );
    expect(messages[0]!.senderDescription).toBe("Principal engineer");
    expect(messages[0]!.channelCoordination).toContain("coordinator;");
  }));

test("a system message, a DM and a sender without a description are left alone", () =>
  withLedger((ledger) => {
    const input = [
      message({
        senderKind: "system",
        senderHandle: "",
        senderDescription: "",
        channelCoordination: undefined,
      }),
      message({ target: "@ada", channelCoordination: undefined, senderDescription: "" }),
    ];
    expect(elideSeenInContext(input, ledger).messages).toEqual(input);
  }));

test("the input is never changed", () =>
  withLedger((ledger) => {
    const input = [message(), message()];
    elideSeenInContext(input, ledger);
    expect(input[1]!.senderDescription).toBe("Staff engineer");
  }));

test("a new context introduces everything again", () =>
  withLedger((ledger) => {
    elideSeenInContext([message()], ledger);
    ledger.advance();
    expect(elideSeenInContext([message()], ledger).messages[0]!.channelCoordination).toBe(ROLE);
  }));

test("only runtimes that report a finished compaction are eligible", () => {
  expect(reportsCompaction("claude-code")).toBe(true);
  expect(reportsCompaction("devin")).toBe(false);
});

test("giving the claims back shows the same text on the next read", () =>
  withLedger((ledger) => {
    const first = elideSeenInContext([message(), message()], ledger);
    first.release();
    const again = elideSeenInContext([message()], ledger).messages[0]!;
    expect(again.senderDescription).toBe("Staff engineer");
    expect(again.channelCoordination).toBe(ROLE);
  }));
