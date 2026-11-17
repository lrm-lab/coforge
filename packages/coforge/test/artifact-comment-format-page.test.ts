import { expect, test } from "bun:test";
import { entry } from "#src/artifact-comment-format";

test("a comment on a place the page named shows its label and excerpt, labelled as the page's", () => {
  const lines = entry(
    {
      id: "abc",
      author: { kind: "user", name: "Lin" },
      version: 2,
      path: "index.html",
      anchor: {
        type: "page",
        data: { name: "plan:two", label: "Plan two", quote: "Ships on Friday" },
      },
      replyTo: null,
      body: "Still true?",
      createdAt: new Date("2026-11-17T00:00:00Z").toISOString(),
    } as never,
    "",
    false,
  );
  expect(lines[0]).toContain(
    'index.html (place plan:two "Plan two", named by the page: "Ships on Friday")',
  );
});
