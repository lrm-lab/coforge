import { expect, test } from "bun:test";

import { originLabel } from "#src/features/artifacts/artifact-origin-link";

const at = (homeKind: "channel" | "dm") => ({ messageId: "m", conversationId: "c", homeKind });

test("a channel source names the channel", () => {
  expect(originLabel(at("channel"), "#launch")).toBe("From a message in #launch");
});

test("a direct-message source names the other person, without the handle sign", () => {
  expect(originLabel(at("dm"), "@Lin Xia")).toBe("From a message with Lin Xia");
});

test("a source whose name is not known yet reads as a plain message", () => {
  expect(originLabel(at("channel"), undefined)).toBe("From a message");
});
