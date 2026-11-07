import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { UnresolvedTaskReference } from "#src/features/tasks/cross-task-reference";

test("a written reference the reader cannot resolve reads as the sender's words", () => {
  const html = renderToStaticMarkup(
    <UnresolvedTaskReference prose>{"#secret:#2"}</UnresolvedTaskReference>,
  );
  expect(html).toBe("#secret:#2");
});

test("a stored token's reader who cannot see the Task gets the locked chip", () => {
  const html = renderToStaticMarkup(
    <UnresolvedTaskReference>{"#design:#7"}</UnresolvedTaskReference>,
  );
  expect(html).not.toBe("#design:#7");
  expect(html).toContain("<span");
});
