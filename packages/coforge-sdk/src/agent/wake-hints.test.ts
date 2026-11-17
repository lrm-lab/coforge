import { expect, test } from "bun:test";
import { decodeWakeHint, decodeWakeHints, type WakeHint } from "./wake-hints";

const hint: WakeHint = {
  target: "#general",
  channelId: "c1",
  channelType: "channel",
  pendingCount: 2,
  firstPendingMsgId: "m1",
  latestMsgId: "m2",
  latestSeq: "7",
  latestSenderName: "ada",
  latestSenderType: "human",
  flags: ["mention"],
};

test("a wake hint decodes unchanged and a null target is allowed", () => {
  expect(decodeWakeHint(hint)).toEqual(hint);
  expect(decodeWakeHint({ ...hint, target: null }).target).toBeNull();
});

test("a list decodes from the response envelope", () => {
  expect(decodeWakeHints({ hints: [hint] })).toEqual([hint]);
});

test("a malformed hint or flag is refused", () => {
  expect(() => decodeWakeHint({ ...hint, flags: ["nope"] })).toThrow("invalid wake hint");
  expect(() => decodeWakeHint({ ...hint, pendingCount: -1 })).toThrow("invalid wake hint");
  expect(() => decodeWakeHint({ ...hint, latestSeq: 7 })).toThrow("invalid wake hint");
  expect(() => decodeWakeHints({ hints: "x" })).toThrow("invalid wake hints");
});

test("the non-member mention flag decodes", () => {
  const flagged = { ...hint, flags: ["mention", "non_member_mention"] };
  expect(decodeWakeHint(flagged)).toEqual(flagged as WakeHint);
});
