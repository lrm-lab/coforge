import { expect, test } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import {
  MARKDOWN_CHUNK_THRESHOLD,
  parseMarkdownChunked,
} from "#src/features/records/report-editor/utils/parse-markdown-chunked";

/** A stand-in parser: one paragraph per blank-line-separated block, so chunks are countable. */
function fakeManager() {
  const chunks: string[] = [];
  return {
    chunks,
    parse(markdown: string): JSONContent {
      chunks.push(markdown);
      return {
        type: "doc",
        content: markdown
          .split("\n\n")
          .filter((block) => block.trim())
          .map((block) => ({ type: "paragraph", content: [{ type: "text", text: block.trim() }] })),
      };
    },
  };
}

const section = (n: number) =>
  `## Section ${n}\n\nThe plan for part ${n}: what ships, who owns it, how it is reviewed.`;

// A note past the threshold must open (task #385): the chunked parse returns the finished doc
// directly (not a promise), with every block of the note in order.
test("a note past the chunk threshold parses in chunks into one complete document", () => {
  const body = `${Array.from({ length: 600 }, (_, i) => section(i + 1)).join("\n\n")}\n\nThe last line of the note.`;
  expect(body.length).toBeGreaterThan(MARKDOWN_CHUNK_THRESHOLD);
  const manager = fakeManager();
  const doc = parseMarkdownChunked(manager, body);
  expect(doc).not.toBeInstanceOf(Promise);
  expect(doc.type).toBe("doc");
  expect(manager.chunks.length).toBeGreaterThan(1);
  const texts = doc.content!.map((node) => node.content![0]!.text);
  expect(texts).toHaveLength(1201);
  expect(texts[0]).toBe("## Section 1");
  expect(texts[1]).toStartWith("The plan for part 1:");
  expect(texts.at(-1)).toBe("The last line of the note.");
  expect(manager.chunks.join("\n")).toBe(body);
});

test("a cut never lands inside a fenced code block", () => {
  const code = ["```", "a", "", "b", "```"].join("\n");
  const body = ["intro", "", code, "", "outro"].join("\n");
  const manager = fakeManager();
  parseMarkdownChunked(manager, body, 3);
  expect(manager.chunks.some((chunk) => chunk.includes("```\na\n\nb\n```"))).toBe(true);
});
