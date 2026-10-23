import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Avatar } from "#src/components/base/avatar/avatar";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";

// A mascot is drawn bare: a caller's ring, radius or fill around it would outline its silhouette.
test("a bare mascot drops the caller's ring, radius and fill, a person keeps them", () => {
  const className = "ring-1 ring-secondary rounded-lg bg-primary group-hover:ring-2 shadow-xs";
  const mascot = renderToStaticMarkup(
    <Avatar src={mascotStaticUrl("blue")} alt="" className={className} border />,
  );
  expect(mascot).not.toMatch(/ring-|rounded-lg|bg-primary/);
  expect(mascot).toContain("shadow-xs");
  const person = renderToStaticMarkup(
    <Avatar src="https://example.com/p.webp" alt="" className={className} />,
  );
  expect(person).toContain("ring-secondary");
  expect(person).toContain("rounded-lg");
});
