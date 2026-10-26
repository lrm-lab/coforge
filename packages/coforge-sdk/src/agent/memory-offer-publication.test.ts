import { expect, test } from "bun:test";
import {
  decodeMemoryOfferPublication,
  decodeOpenVikingAgentResponse,
  OPENVIKING_AGENT_PROTOCOL,
} from "./openviking-memory";

test("Offer outcome metadata is independent of the HTTP error code", () => {
  expect(decodeMemoryOfferPublication({ phase: "rejected_before_publish" })).toEqual({
    phase: "rejected_before_publish",
  });
  expect(decodeMemoryOfferPublication({ phase: "published", messageId: "message" })).toEqual({
    phase: "published",
    messageId: "message",
  });
  for (const value of [
    undefined,
    null,
    [],
    {},
    { phase: "unknown" },
    { phase: "published" },
    { phase: "published", messageId: " " },
    { phase: "rejected_before_publish", messageId: "already-published" },
  ])
    expect(decodeMemoryOfferPublication(value)).toBeUndefined();
});

test("Offer decoding preserves a validated publication receipt", () => {
  const response = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "offer-a",
    duplicate: true,
    published: true,
    messageId: "message",
    citations: [],
    publication: { phase: "published" as const, messageId: "message" },
  };
  expect(decodeOpenVikingAgentResponse("offer", response)).toEqual(response);
});
