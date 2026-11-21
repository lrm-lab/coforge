import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorySection } from "#src/features/conversations/directory-section-group";

const render = (expanded: boolean | undefined) =>
  renderToStaticMarkup(
    <DirectorySection label="Channels" count={1} expanded={expanded} onToggle={() => {}}>
      <ul>
        <li>general</li>
      </ul>
    </DirectorySection>,
  );

test("a folded section keeps its rows mounted, shut and inert", () => {
  const html = render(false);
  expect(html).toContain('data-fold="shut"');
  expect(html).toContain("inert");
  expect(html).toContain("general");
});

test("an open section shows its rows in an open fold", () => {
  const html = render(true);
  expect(html).toContain('data-fold="open"');
  expect(html).not.toContain("inert");
});

test("a fold the directory makes itself (no toggle pressed) changes at once", () => {
  expect(render(false)).toContain("transition-none");
  expect(render(true)).toContain("transition-none");
});

test("a collapsible section places its chevron inside the heading button with no trailing chevron button", () => {
  const closed = render(false);
  const open = render(true);
  expect(closed.match(/<button\b/g)).toHaveLength(1);
  expect(closed).toContain("<svg");
  expect(closed).not.toContain("rotate-90");
  expect(open).toContain("rotate-90");
});
