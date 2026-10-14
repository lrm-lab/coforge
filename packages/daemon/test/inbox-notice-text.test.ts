import { expect, test } from "bun:test";
import { inboxNoticeText } from "#src/daemon-runtime/agent-message-attention-index";

const hint =
  "Drain each listed target with `coforge message check --target '<target>'`, or inspect with `coforge message read --target '<target>'`. Either may return nothing, because a message can already have been read.\n" +
  "Targets starting with # must be quoted. Send bodies on stdin, never a positional argument; double quotes expand backticks and $, so use a single-quoted heredoc delimiter:\n" +
  "coforge message check --target '#channel'\n" +
  "coforge message send --target '#channel' <<'COFORGE_MESSAGE'\n" +
  "Your reply text, with literal `backticks` and $variables preserved.\n" +
  "COFORGE_MESSAGE";

test("a delivery notice names its count, one row per target, and how to drain them", () => {
  expect(inboxNoticeText(undefined, 1, ["@ada  new: 1 message · latest sender @ada"])).toBe(
    `[CoForge inbox notice:\nInbox update: 1 message delivered or held for you\n@ada  new: 1 message · latest sender @ada\n${hint}]`,
  );
});

test("a recovery notice names its occasion and counts in the plural", () => {
  expect(
    inboxNoticeText("restart recovery", 3, ["#general  new: 2 messages", "@ada  new: 1 message"]),
  ).toBe(
    `[CoForge inbox notice (restart recovery):\nInbox update: 3 messages delivered or held for you\n#general  new: 2 messages\n@ada  new: 1 message\n${hint}]`,
  );
});
