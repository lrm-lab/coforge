import { expect, test } from "bun:test";
import {
  MARKDOWN_SECTIONED_MIN_LENGTH,
  markdownSections,
} from "#src/features/conversations/markdown-sections";

const filler = (length: number) =>
  `${"lorem ipsum ".repeat(Math.ceil(length / 12)).slice(0, length)}\n`;
const long = (body: string) => `${body}\n${filler(MARKDOWN_SECTIONED_MIN_LENGTH)}`;

test("a short file is one section", () => {
  expect(markdownSections("# A\n\ntext\n\n## B\n\nmore")).toEqual(["# A\n\ntext\n\n## B\n\nmore"]);
});

test("a long file is cut before each h1–h3 heading and joins back to itself", () => {
  const text = long("intro\n# One\n\ntext\n## Two\n### Three\n#### Four stays\nend");
  const sections = markdownSections(text);
  expect(sections.join("")).toBe(text);
  expect(sections.map((section) => section.split("\n")[0])).toEqual([
    "intro",
    "# One",
    "## Two",
    "### Three",
  ]);
  expect(sections[3]).toStartWith("### Three\n#### Four stays\n");
});

test("a heading inside a fenced code block does not cut", () => {
  const text = long("# One\n```md\n# not a heading\n```js\n# still code\n````\n## Two");
  const sections = markdownSections(text);
  expect(sections.join("")).toBe(text);
  expect(sections).toHaveLength(2);
  expect(sections[1]).toStartWith("## Two");
});

test("a tilde fence closes only on tildes", () => {
  const text = long("~~~\n```\n# code\n~~~\n# One");
  expect(markdownSections(text).map((section) => section.slice(0, 5))).toEqual(["~~~\n`", "# One"]);
});

test("a file with link reference or footnote definitions stays whole", () => {
  expect(
    markdownSections(long("# One\n[a][ref]\n## Two\n\n[ref]: https://example.com")),
  ).toHaveLength(1);
  expect(markdownSections(long("# One\nNote[^1]\n## Two\n\n[^1]: footnote"))).toHaveLength(1);
});

test("a fence in a list item or quote keeps its lines, even ones that look like headings", () => {
  const text = long("# A\n- ```sh\n  # install\n  npm i\n  ```\n> ```\n> # quoted\n> ```\n## B");
  const sections = markdownSections(text);
  expect(sections.join("")).toBe(text);
  expect(sections.map((section) => section.split("\n")[0])).toEqual(["# A", "## B"]);
});

test("an indented heading inside a list item does not cut", () => {
  expect(markdownSections(long("# A\n1. foo\n   # bar\n## B"))).toHaveLength(2);
});

test("CRLF line endings cut the same way", () => {
  const text = long("# A\r\n```\r\ncode\r\n```\r\n## B\r\n## C")
    .replaceAll("\n", "\r\n")
    .replaceAll("\r\r", "\r");
  const sections = markdownSections(text);
  expect(sections.join("")).toBe(text);
  expect(sections.map((section) => section.slice(0, 4))).toEqual(["# A\r", "## B", "## C"]);
});

test("a backtick line with a backtick in its info string is no fence", () => {
  expect(markdownSections(long("# A\n```foo```\n## B"))).toHaveLength(2);
});
