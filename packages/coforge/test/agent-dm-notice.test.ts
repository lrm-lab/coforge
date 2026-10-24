import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { AGENT_DM_NOTICE, formatMessageLine } from "../src/message-format";

const message = (overrides: Partial<AgentMessageRecord>): AgentMessageRecord => ({
  id: "01a16f00-0000-7000-8000-000000000000",
  sequence: 1,
  senderKind: "agent",
  senderHandle: "beta",
  senderDescription: "",
  body: "can you look at this?",
  createdAt: "2026-10-24T12:00:00.000Z",
  target: "@beta",
  attachments: [],
  ...overrides,
});

test("a direct message from another Agent says to answer once and stop", () => {
  expect(formatMessageLine(message({}))).toContain(AGENT_DM_NOTICE);
  // The suffix of a shared name does not hide who wrote it.
  expect(formatMessageLine(message({ target: "@beta~agent" }))).toContain(AGENT_DM_NOTICE);
  expect(formatMessageLine(message({ target: "@beta~agent:01a16f00-aaaa" }))).toContain(
    AGENT_DM_NOTICE,
  );
});

test("the Agent's own message, a person's, a channel's and a system notice carry no such notice", () => {
  expect(formatMessageLine(message({ senderHandle: "alpha" }))).not.toContain(AGENT_DM_NOTICE);
  expect(formatMessageLine(message({ senderKind: "human", senderHandle: "beta" }))).not.toContain(
    AGENT_DM_NOTICE,
  );
  expect(formatMessageLine(message({ target: "#general" }))).not.toContain(AGENT_DM_NOTICE);
  expect(formatMessageLine(message({ senderKind: "system", senderHandle: "" }))).not.toContain(
    AGENT_DM_NOTICE,
  );
});
