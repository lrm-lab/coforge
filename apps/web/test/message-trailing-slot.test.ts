import { expect, test } from "bun:test";

import { rehypeTrailingSlot } from "#src/features/conversations/message-markdown";

/** Runs the trailing-slot pass and returns where its slot landed, as a tag path from the root. */
function slotPath(children: unknown[]) {
  const tree = { type: "root", children } as never;
  rehypeTrailingSlot()(tree);
  const path: string[] = [];
  let node = tree as { children: Array<Record<string, unknown>> };
  for (;;) {
    const last = node.children[node.children.length - 1] as {
      tagName?: string;
      properties?: Record<string, unknown>;
      children: Array<Record<string, unknown>>;
    };
    if (last.properties?.dataTrailingSlot !== undefined) return path;
    path.push(last.tagName ?? "?");
    node = last;
  }
}

function text(value: string) {
  return { type: "text", value };
}

function element(tagName: string, children: unknown[]) {
  return { type: "element", tagName, properties: {}, children };
}

test("what follows a body's last word joins the end of its final paragraph", () => {
  expect(slotPath([element("p", [text("one")]), text("\n"), element("p", [text("two")])])).toEqual([
    "p",
  ]);
});

test("a body ending in a list puts it at the end of the last item, through nested lists", () => {
  const nested = element("ul", [element("li", [text("inner")])]);
  expect(
    slotPath([element("ul", [element("li", [text("a")]), element("li", [text("b"), nested])])]),
  ).toEqual(["ul", "li", "ul", "li"]);
  expect(slotPath([element("ol", [element("li", [element("p", [text("loose")])])])])).toEqual([
    "ol",
    "li",
    "p",
  ]);
});

test("a list item ending in inline markup takes it after that markup, not inside it", () => {
  expect(
    slotPath([element("ul", [element("li", [text("a "), element("strong", [text("b")])])])]),
  ).toEqual(["ul", "li"]);
});

test("after a final code block or table, which have no line to join, it follows the block", () => {
  expect(
    slotPath([element("p", [text("log")]), element("pre", [element("code", [text("x")])])]),
  ).toEqual([]);
  expect(slotPath([element("blockquote", [element("pre", [])])])).toEqual(["blockquote"]);
});
