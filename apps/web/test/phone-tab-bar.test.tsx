import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PhoneTabBar } from "#src/components/layout/phone-tab-bar";

const baseProps = {
  chatHref: "/w/demo",
  activityHref: "/w/demo/activity",
  activityUnread: { count: 3, lit: true },
  base: "/w/demo",
  user: { name: "Ada", avatarUrl: null },
  scrollRootRef: { current: null },
};

test("phone tab bar uses Untitled UI navigation icons and preserves unread badge and avatar", () => {
  const html = renderToStaticMarkup(<PhoneTabBar {...baseProps} current="chat" />);

  const svgs = html.match(/<svg[^>]*>/g) ?? [];
  expect(svgs).toHaveLength(3);
  for (const svg of svgs) {
    expect(svg).toContain('viewBox="0 0 24 24"');
  }

  const links = html.match(/<a\b[^>]*class="phone-foot-bar__link[^"]*"/g) ?? [];
  expect(links).toHaveLength(4);
  expect(html).toContain('href="/w/demo" aria-current="page"');
  expect(html).toContain(">3<");
});

test("phone tab bar reflects active states on activity, workspace, and me", () => {
  const activityHtml = renderToStaticMarkup(<PhoneTabBar {...baseProps} current="activity" />);
  expect(activityHtml).toContain('href="/w/demo/activity" aria-current="page"');
  expect(activityHtml).toContain("ring-nav-bg-current");

  const meHtml = renderToStaticMarkup(<PhoneTabBar {...baseProps} current="me" />);
  expect(meHtml).toMatch(/href="[^"]*\/w\/demo\/me" aria-current="page"/);
  expect(meHtml).toContain("ring-2 ring-nav-fg-current");
});

test("phone tab bar imports MessageChatSquare, Activity, and Grid01 from @untitledui/icons", () => {
  const source = readFileSync(
    new URL("../src/components/layout/phone-tab-bar.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain(
    'import { Activity, Grid01, MessageChatSquare } from "@untitledui/icons";',
  );
});
