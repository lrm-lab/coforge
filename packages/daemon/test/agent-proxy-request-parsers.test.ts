import { expect, test } from "bun:test";
import { parseActionPrepareRequest } from "#src/agent-proxy-request-parsers";

const choice = {
  type: "choice",
  prompt: "Which?",
  to: "@alice",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

test("a deadline reaches the server on a choice card, and is refused on a kind that cannot take one", () => {
  const kept = parseActionPrepareRequest({
    target: "#ops",
    action: { ...choice, expiresInMinutes: 120 },
  });
  expect(kept).not.toBeInstanceOf(Response);
  expect(kept).toMatchObject({ action: { expiresInMinutes: 120 } });

  // The schema would strip it silently, and the card would wait a day instead of what was asked.
  const refused = parseActionPrepareRequest({
    target: "#ops",
    action: { type: "channel:create", name: "ops", expiresInMinutes: 120 },
  });
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(400);
});
