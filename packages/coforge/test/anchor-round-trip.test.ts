import { describe, expect, test } from "bun:test";

import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";

import { parseArgs } from "../index";

describe("the short thread form the CLI prints round-trips through its own grammars", () => {
  // Task #88: the v7 collision moved the printed short id from eight hex to twelve hex with the
  // uuid's first dash. Every display that prints a short form and every parser that accepts one
  // must agree, or an Agent that copies a printed `replyTarget` gets a Usage error and thread
  // replies break. The display format lives in message-format's `shortId`; the target grammars
  // are the parse branches and the SDK's channel-target check.
  for (const short of [
    "01a1332b-2592", // first two uuid groups: the twelve hex + dash the CLI prints
    "01a1332b", // the eight-hex form older CLIs printed
  ]) {
    test(`"${short}" round-trips as a channel-thread target`, () => {
      const target = `#coforge:${short}`;
      expect(isChannelMessageTarget(target)).toBe(true);
      expect(parseArgs(["message", "send", "--target", target])).toMatchObject({
        command: "send",
        target,
      });
      expect(parseArgs(["message", "react", "--message-id", short, "--emoji", "👍"])).toMatchObject(
        { command: "react" },
      );
      expect(parseArgs(["thread", "unfollow", "--target", target])).toMatchObject({
        command: "thread-unfollow",
        target,
      });
    });
  }

  test(`an agent target with the dash round-trips too`, () => {
    const target = "@ada:01a1332b-2592";
    expect(parseArgs(["message", "send", "--target", target])).toMatchObject({
      command: "send",
      target,
    });
  });

  test(`reminder schedule's messageId check accepts the same forms`, async () => {
    const { isReminderMessageAnchor } = await import("@lrm/coforge-sdk/internal");
    expect(isReminderMessageAnchor("01a1332b-2592")).toBe(true);
    expect(isReminderMessageAnchor("01a1332b")).toBe(true);
    expect(isReminderMessageAnchor("01a1332b-2592-4789-8abc-def012345678")).toBe(true);
    expect(isReminderMessageAnchor("abcdef123")).toBe(false);
  });

  test(`a nine-plus-hex undashed anchor stays refused as a send target`, () => {
    expect(isChannelMessageTarget("#coforge:abcdef123")).toBe(false);
    expect(() => parseArgs(["thread", "unfollow", "--target", "#coforge:abcdef123"])).toThrow(
      "Usage:",
    );
  });
});
