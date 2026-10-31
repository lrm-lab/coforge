import { expect, test } from "bun:test";
import { channelLabel } from "#src/features/conversations/channel-visibility";

test("a channel's text label keeps `#` for a public channel and drops it for a private one", () => {
  expect(channelLabel({ name: "plaza" })).toBe("#plaza");
  expect(channelLabel({ name: "plaza", visibility: "public" })).toBe("#plaza");
  expect(channelLabel({ name: "vault", visibility: "private" })).toBe("vault");
});
