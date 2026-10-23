import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Spinner } from "#src/components/ui/spinner";

test("Spinner is a decorative svg stroked with the current color that rotates only with motion allowed", () => {
  const html = renderToStaticMarkup(<Spinner className="size-4" />);

  expect(html).toContain("<svg");
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('stroke="currentColor"');
  expect(html).toContain("motion-safe:animate-spin");
  expect(html).toContain("size-4");
  expect(html).not.toContain("size-5");
});
