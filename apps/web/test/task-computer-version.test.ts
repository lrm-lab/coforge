import { expect, test } from "bun:test";
import { computerSupportsTaskConversations } from "#src/server/computers/task-computer-version.server";

test("a Computer from 0.1.19 on serves task conversations, development builds included", () => {
  for (const version of ["0.1.19", "0.1.19-dev.3", "0.1.19-rc.1", "0.1.20", "0.2.0", "1.0.0"])
    expect(computerSupportsTaskConversations(version)).toBe(true);
});

test("an older, unknown or unreadable version does not", () => {
  for (const version of [
    "0.1.18",
    "0.1.18-dev.9",
    "0.1.0",
    "0.0.99",
    "",
    "latest",
    null,
    undefined,
  ])
    expect(computerSupportsTaskConversations(version)).toBe(false);
});
