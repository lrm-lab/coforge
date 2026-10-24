import { expect, test } from "bun:test";
import { refusalNextAction } from "../src/refusal-guidance";

test("a send to a name a person and an Agent share says to pick one with a suffix", () => {
  const next = refusalNextAction("send", { status: 409, code: "AMBIGUOUS_TARGET" }, "@ada");

  expect(next).toStartWith("No message was sent");
  expect(next).toContain("@ada~human");
  expect(next).toContain("@ada~agent");
});

test("the suffix of a target already carrying one is not doubled", () => {
  const next = refusalNextAction(
    "send",
    { status: 409, code: "AMBIGUOUS_TARGET" },
    "@ada~agent:abc",
  );

  expect(next).toContain("ada~human");
  expect(next).not.toContain("~agent~");
});

test("a send refused for too many messages between Agents says to stop, not to retry elsewhere", () => {
  for (const code of ["AGENT_DM_CHAIN_LIMIT", "AGENT_DM_RATE_LIMIT"]) {
    const next = refusalNextAction("send", { status: 429, code, retryable: true }, "@ada");

    expect(next).toStartWith("No message was sent");
    expect(next).toContain("do not");
    expect(next).toContain("another conversation");
  }
});
