import type { Element, Root } from "hast";

// A list item's text may sit in a paragraph of its own (a loose list); a quote holds blocks.
const SLOT_CONTAINERS = new Set(["ul", "ol", "li", "blockquote"]);
const SLOT_TEXT_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

function lastElement(parent: Root | Element): Element | undefined {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index];
    if (child.type === "element") return child;
  }
  return undefined;
}

/**
 * Marks where `trailing` goes: the end of the body's last paragraph, heading or list item, found
 * through lists and quotes, so it reads on that line's end; after a final code block or table,
 * which have no line to join, it starts the next line. The slot is a `span[data-trailing-slot]`,
 * which `MessageBody` renders as what it was given.
 */
export function rehypeTrailingSlot() {
  return (tree: Root) => {
    let parent: Root | Element = tree;
    for (;;) {
      const last = lastElement(parent);
      if (!last) break;
      if (SLOT_TEXT_BLOCKS.has(last.tagName)) {
        parent = last;
        break;
      }
      if (!SLOT_CONTAINERS.has(last.tagName)) break;
      parent = last;
    }
    parent.children.push({
      type: "element",
      tagName: "span",
      properties: { dataTrailingSlot: "" },
      children: [],
    });
  };
}
