/**
 * Left-navigation icons follow the design spec: a resting icon draws in the
 * `--color-nav-icon` token (#777DBD) with a 2px stroke, while the current item
 * keeps the brand accent and the token stays out of non-nav icon slots.
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
import { SidebarExpanded } from "#src/components/layout/sidebar/sidebar-expanded";
import { m } from "#src/paraglide/messages";

const Icon = (props: { className?: string }) => (
  <svg className={props.className} data-testid="nav-icon" />
);

const items = [
  { href: "/chat", label: m.navigation_chat(), icon: Icon },
  { href: "/agents", label: m.navigation_agents(), icon: Icon },
];
const footer = <div id="footer-slot" />;
const railProps = { activeUrl: "/chat", items, footer };

test("Rail: the resting icon carries the nav-icon token and a 2px stroke", () => {
  const markup = renderToStaticMarkup(<SidebarRail {...railProps} />);
  expect(markup).toContain("text-nav-icon");
  expect(markup).toContain("stroke-[2.4]");
});

test("Sidebar (expanded, and the mobile drawer): same token and 2px stroke on its icon", () => {
  const markup = renderToStaticMarkup(<SidebarExpanded {...railProps} />);
  expect(markup).toContain("text-nav-icon");
  expect(markup).toContain("stroke-[2px]");
});

test("The current item keeps the brand accent; the resting icon never uses the old caption gray", () => {
  const iconClasses = (
    renderToStaticMarkup(<SidebarRail {...railProps} />).match(/<svg class="([^"]+)"/g) ?? []
  ).map((hit) => hit.replace('<svg class="', "").replace('"', ""));
  expect(iconClasses).toHaveLength(2);
  const current = iconClasses.find((cls) => cls.includes("text-brand-secondary"));
  const resting = iconClasses.find((cls) => cls.includes("text-nav-icon"));
  expect(current).toBeTruthy();
  expect(resting).toBeTruthy();
  expect(current).toContain("stroke-[2.4]");
  expect(resting).toContain("stroke-[2.4]");
  expect(resting).not.toContain("text-tertiary");
});

test("The token exists in the theme with the specified value, in both modes", async () => {
  const css = await Bun.file(new URL("../src/styles/coforge-theme.css", import.meta.url)).text();
  const matches = css.match(/--color-nav-icon:\s*([^;]+);/g) ?? [];
  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) expect(match.toLowerCase()).toContain("#777dbd");
});
