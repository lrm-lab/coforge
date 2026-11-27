import { expect, test } from "bun:test";
import { decodeAgentChannelErrorResponse, type AgentChannelErrorResponse } from "./channels";

test("decodeAgentChannelErrorResponse accepts every declared channel error code", () => {
  for (const errorCode of [
    "agent_not_visible",
    "channel_announcement_ref_invalid",
    "pinned_artifact_not_in_conversation",
    "ambiguous_target",
  ] as const) {
    const error: AgentChannelErrorResponse = {
      ok: false,
      errorCode,
      error: "explained refusal",
    };
    expect(decodeAgentChannelErrorResponse(error)).toEqual(error);
  }
});

test("decodeAgentChannelErrorResponse rejects an unrecognized errorCode or a success body", () => {
  expect(
    decodeAgentChannelErrorResponse({ ok: false, errorCode: "other", error: "x" }),
  ).toBeUndefined();
  expect(decodeAgentChannelErrorResponse({ idempotencyKey: "k", target: "#x" })).toBeUndefined();
  expect(decodeAgentChannelErrorResponse(undefined)).toBeUndefined();
});
