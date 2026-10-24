import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { AGENT_DM_NOTICE, formatAgentDmHint, formatMessageLine } from "../src/message-format";

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

test("an output with a direct message from another Agent ends with the notice, once", () => {
  const hint = formatAgentDmHint([
    message({}),
    message({ id: "01a16f00-0000-7000-8000-000000000001" }),
  ]);
  expect(hint).toBe(AGENT_DM_NOTICE);
  // The suffix of a shared name does not matter: the sender's type decides.
  expect(formatAgentDmHint([message({ target: "@beta~agent:01a16f00-aaaa" })])).toBe(
    AGENT_DM_NOTICE,
  );
  expect(formatMessageLine(message({}))).not.toContain(AGENT_DM_NOTICE);
});

test("a person's message, a channel's and a system notice add no notice", () => {
  expect(formatAgentDmHint([message({ senderKind: "human" })])).toBe("");
  expect(formatAgentDmHint([message({ target: "#general" })])).toBe("");
  expect(formatAgentDmHint([message({ senderKind: "system", senderHandle: "" })])).toBe("");
});
