import { describe, expect, test } from "bun:test";
import { readMessageReferences } from "./message-references";

// task #465: the shared parser's contract — web, server and CLI read a body's references the
// same way. Code spans and links are not references; priorities and trailing boundaries match.
describe("the shared message-reference parser", () => {
  test.each([
    [{ body: "see task #12 in #coforge", candidates: { taskNumbers: [12] } }],
    [
      {
        body: "in #general:abcdef the reply",
        candidates: { threads: [{ name: "general", anchor: "abcdef" }] },
      },
    ],
    [{ body: "dm:@alice:#5 the task", candidates: { dmTasks: [{ peer: "alice", number: 5 }] } }],
    [
      {
        body: "#other:#9 another board",
        candidates: { channelTasks: [{ name: "other", number: 9 }] },
      },
    ],
    [{ body: "plain #general a channel", candidates: { channelNames: ["general"] } }],
    [{ body: "a bare #7 the number", candidates: { taskNumbers: [7] } }],
    [{ body: "`task #12` in a code span", candidates: { taskNumbers: [] } }],
    [{ body: "[task #12](https://x) a link", candidates: { taskNumbers: [] } }],
    [{ body: "@alice a mention", candidates: { handles: ["alice"] } }],
  ])("reads the same candidates for %#", ({ body, candidates }) => {
    expect(readMessageReferences(body).candidates).toMatchObject(candidates);
  });
});
