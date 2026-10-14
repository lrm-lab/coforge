import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/** One line for the Agent workspace tab's path row: the path truncates, the copy button stays put.
 *
 * The bug this guards: the row carried `flex-wrap`. A wrapping flex container breaks lines from the
 * items' flex-base sizes, and the path span's base size is its untruncated width - `truncate` and
 * `min-w-0` only matter once the line is already shrinking - so an overlong path pushed the copy
 * button onto a second line before any shrinking happened (the reported screenshot: button alone on
 * the second line, left-aligned by `justify-between`).
 *
 * The layout itself cannot be measured here - there is no renderer, and the tab needs a live daemon
 * file listing - so this pins the decision instead of the pixels: no `flex-wrap` on the row,
 * `shrink-0` on the button, and the span keeps what makes it ellipsize. A better layout is welcome;
 * it just has to arrive with its own reason, the way this one did.
 *
 * Only the row's own tags are read: the comment above the row quotes `flex-wrap` on purpose, when
 * explaining why it must not come back. */
const source = readFileSync(
  new URL("../src/features/agents/profile-panel/agent-workspace-tab.tsx", import.meta.url),
  "utf8",
);

const PATH_SPAN_AT = source.indexOf('<span className="min-w-0 truncate');

/** The slice from `start`'s tag to the end of that tag. */
function startTagAt(index: number): string {
  expect(index).toBeGreaterThanOrEqual(0);
  const tagEnd = source.indexOf(">", index);
  expect(tagEnd).toBeGreaterThan(index);
  return source.slice(index, tagEnd + 1);
}

/** The row that holds the path span and the copy button: the last `<div …>` before the span. */
function pathRowTag(): string {
  return startTagAt(source.lastIndexOf("<div", PATH_SPAN_AT));
}

/** The path span itself. */
function pathSpanTag(): string {
  return startTagAt(PATH_SPAN_AT);
}

/** The copy button for the same row: the first `ButtonUtility` after the path span. */
function copyButtonBlock(): string {
  const buttonAt = source.indexOf("<ButtonUtility", PATH_SPAN_AT);
  expect(buttonAt).toBeGreaterThan(PATH_SPAN_AT);
  const closeAt = source.indexOf("/>", buttonAt);
  expect(closeAt).toBeGreaterThan(buttonAt);
  return source.slice(buttonAt, closeAt);
}

test("the path row lays out one line, with the path as its shrinking item", () => {
  const row = pathRowTag();
  expect(row).not.toContain("flex-wrap");
  expect(row).toContain("flex");
  expect(row).toContain("items-center");
  // Without both classes the path would overflow the row instead of ellipsizing in it.
  expect(pathSpanTag()).toContain("min-w-0");
  expect(pathSpanTag()).toContain("truncate");
});

test("the copy button cannot collapse, so it stays beside the path", () => {
  expect(copyButtonBlock()).toContain('className="shrink-0"');
});
