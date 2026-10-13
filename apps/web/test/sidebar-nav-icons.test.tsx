/**
 * Left-navigation icons follow the design spec: a resting icon draws in the
 * `--color-nav-icon` token with a 2px stroke (#777DBD in light, lightened in dark), while the current item
 * keeps the brand accent and the token stays out of non-nav icon slots.
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SIDEBAR_RAIL_WIDTH, SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
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

test("The collapsed rail is an icon column and each item keeps its name", () => {
  // Captions are gone, so the rail is the icon column again. 6.75rem only existed to fit
  // "Conversations" under the icon. The name is the link's accessible name; RailItem also
  // passes it to Tooltip with placement "right". A closed tooltip is not in the static tree.
  expect(SIDEBAR_RAIL_WIDTH).toBe("5rem");
  const markup = renderToStaticMarkup(<SidebarRail {...railProps} />);
  expect(markup).toContain("overflow-x-hidden");
  expect(markup).not.toContain("truncate text-center");
  expect(markup).not.toContain("h-18");
  expect(markup).toContain("h-11");
  expect(markup).toContain(`aria-label="${m.navigation_chat()}"`);
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('data-react-aria-pressable="true"');
  expect(markup).not.toContain("rail-labels-hidden");
  const chat = m.navigation_chat();
  const visible = markup.replace(/aria-label="[^"]*"/g, "");
  expect(visible).not.toContain(`>${chat}<`);
});

test("A rail icon's name is the official tooltip, placed to the right", async () => {
  // A closed tooltip is portaled and absent from static markup, so this locks the wiring
  // the hover actually uses: the same label, on the official Tooltip, to the right of the icon.
  const source = await Bun.file(
    new URL("../src/components/layout/sidebar/sidebar-rail.tsx", import.meta.url),
  ).text();
  expect(source).toContain('<Tooltip title={label} placement="right">');
  expect(source).toContain('tooltipPlacement="right"');
});

test("The token carries the spec's value in light, and a lighter one for the dark column", async () => {
  const css = await Bun.file(new URL("../src/styles/coforge-theme.css", import.meta.url)).text();
  const values = [...css.matchAll(/--color-nav-icon:\s*([^;]+);/g)].map((hit) =>
    hit[1]!.trim().toLowerCase(),
  );
  // The spec's periwinkle is the light value; dark re-points it, because this one dropped to
  // 4.4:1 on the dark sidebar and read muddy next to the current item's accent.
  expect(values[0]).toBe("#777dbd");
  expect(values).toHaveLength(2);
  expect(values[1]).not.toBe("#777dbd");
});
