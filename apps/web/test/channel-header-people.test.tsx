import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChannelHeaderFaces,
  type ChannelHeaderFace,
} from "#src/features/conversations/channel-header-people";

const roster = (extraAgents: number): ChannelHeaderFace[] => [
  {
    kind: "human",
    key: "user:00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000001",
    displayName: "Ada",
    avatarUrl: null,
  },
  {
    kind: "human",
    key: "user:00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000002",
    displayName: "Grace",
    avatarUrl: null,
  },
  {
    kind: "human",
    key: "user:00000000-0000-4000-8000-000000000003",
    userId: "00000000-0000-4000-8000-000000000003",
    displayName: "Jing",
    avatarUrl: null,
  },
  ...Array.from({ length: extraAgents }, (_, index) => ({
    kind: "agent" as const,
    key: `agent:00000000-0000-4000-8000-0000000001${String(index + 1).padStart(2, "0")}`,
    agentId: `00000000-0000-4000-8000-0000000001${String(index + 1).padStart(2, "0")}`,
    name: `agent-${index + 1}`,
    displayName: `Agent ${index + 1}`,
    avatarUrl: null,
  })),
];

test("channel header cluster renders 32px faces, spec +N chip, and dashed add button", () => {
  const html = renderToStaticMarkup(
    <ChannelHeaderFaces
      entries={roster(8)}
      canAdd
      onOpenMembers={() => {}}
      onAddMembers={() => {}}
    />,
  );

  expect(html).toContain("avatar-portrait");
  expect(html).toContain("avatar-header");
  expect(html).toContain("avatar-stack-face ring-2 ring-bg-primary");
  expect(html).not.toContain("ring-[1.5px]");

  expect(html).toContain(">+7<");
  expect(html).toContain("bg-avatar-more");
  expect(html).toContain("[&amp;&gt;span]:text-avatar-more-fg");
  expect(html).toContain("text-sm font-semibold");
  expect(html).toContain("outline-none");

  expect(html).toMatch(/border-dashed[^"]*size-8[^"]*border-secondary[^"]*text-avatar-add-fg/);
});

test("three-digit overflow expands into a 32px-tall pill instead of clipping", () => {
  const html = renderToStaticMarkup(
    <ChannelHeaderFaces
      entries={roster(105)}
      canAdd={false}
      onOpenMembers={() => {}}
      onAddMembers={() => {}}
    />,
  );
  expect(html).toContain(">+104<");
  expect(html).toContain("[&amp;&amp;]:w-auto");
  expect(html).toContain("px-1.5");
});

test("stacked stickers keep a pure white disc in both themes while portrait hairlines stay off", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const theme = readFileSync(new URL("../src/styles/coforge-theme.css", import.meta.url), "utf8");

  expect(styles).toMatch(
    /\.avatar-stack-face\[data-avatar-sticker\][\s\S]*?background-color:\s*var\(--color-avatar-outline\);/,
  );
  expect(styles).toMatch(
    /\[data-avatar\]\.avatar-portrait\s*>\s*:first-child\s*\{\s*outline:\s*none;/,
  );
  expect(theme).toContain("--color-avatar-outline: #ffffff;");
  expect(theme).toContain("--color-avatar-more: #f9f5ff;");
  expect(theme).toContain("--color-avatar-more-fg: var(--color-brand-600);");
  expect(theme).toContain("--color-avatar-add-fg: #777d8d;");
});
