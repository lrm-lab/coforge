import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import {
  AgentContextSection,
  type AgentContextPopoverData as SectionData,
} from "#src/features/agents/agent-context-popover";
import { m } from "#src/paraglide/messages";

const report = {
  provider: "claude-code" as RuntimeProvider,
  model: "claude-haiku-4-5-20251001",
  usedTokens: 24_900,
  windowTokens: 200_000,
  observedAt: "2026-09-18T00:00:00.000Z",
  categories: [
    { name: "System prompt", tokens: 6_400 },
    { name: "System tools", tokens: 9_600 },
    { name: "Memory files", tokens: 151 },
    { name: "Free space", tokens: 175_100 },
  ],
  memoryFiles: [{ kind: "User", path: "/home/agent/.claude/CLAUDE.md", tokens: 151 }],
  skills: [
    { name: "find-docs", source: "User", tokens: 220 },
    { name: "init", source: "Built-in", tokens: 20, approximate: true },
  ],
};

const fresh = (overrides: Partial<SectionData["result"]> = {}): SectionData => ({
  state: "fresh",
  result: {
    scanId: "scan-1",
    status: "available",
    report,
    collectedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  },
});

const usage = {
  usedTokens: 24_900,
  windowTokens: 200_000,
  observedAtMs: Date.parse("2026-09-18T00:00:00.000Z"),
};

function section(data: SectionData | undefined, scanning = false) {
  return renderToStaticMarkup(
    <AgentContextSection
      usage={usage}
      report={{ data, scanning, onRefresh: () => {} }}
      timeZone="UTC"
    />,
  );
}

test("renders the context row, then the stacked bar, category table, and the two collapsible lists", () => {
  const markup = section(fresh());
  expect(markup).toContain(m.agent_context_title());
  expect(markup).toContain("24,900");
  expect(markup).toContain("200,000");
  expect(markup).toContain("claude-haiku-4-5-20251001");
  expect(markup).toContain("System prompt");
  expect(markup).toContain("Memory files");
  expect(markup).toContain("/home/agent/.claude/CLAUDE.md");
  expect(markup).toContain("find-docs");
  // Free space is drawn as the neutral remainder, never as a warning colour.
  expect(markup).toContain("Free space");
});

test("the composition sits in a disclosure that starts collapsed", () => {
  const markup = section(fresh());
  expect(markup).toContain('aria-expanded="false"');
});

test("without a report (non-Claude-Code) the section is just the row", () => {
  const markup = renderToStaticMarkup(<AgentContextSection usage={usage} timeZone="UTC" />);
  expect(markup).toContain(m.agent_context_title());
  expect(markup).toContain("24,900");
  expect(markup).not.toContain(m.agent_context_refresh());
  expect(markup).not.toContain(m.agent_context_categories());
});

test("recomputes each category's share from its tokens and the window size", () => {
  const markup = section(fresh());
  // 6_400 / 200_000 = 3.2% -> 3%; 175_100 / 200_000 = 87.55% -> 88%.
  expect(markup).toContain("3%");
  expect(markup).toContain("88%");
});

test("a reading with no report shows the failed state's reason inline, with a Refresh button", () => {
  for (const [status, expected] of [
    ["no_session", m.agent_context_status_no_session()],
    ["unsupported", m.agent_context_status_unsupported()],
    ["unparsed", m.agent_context_status_unparsed()],
    ["timeout", m.agent_context_status_timeout()],
    ["error", m.agent_context_status_error()],
  ] as const) {
    const markup = section(fresh({ status, report: undefined }));
    // renderToStaticMarkup escapes apostrophes; compare against the escaped form too.
    expect(markup).toContain(expected.replaceAll("'", "&#x27;"));
    expect(markup).toContain(m.agent_context_refresh());
  }
});

test("a missing reading shows the reading placeholder; a stale one shows the stale note", () => {
  expect(section({ state: "missing", pendingScanId: "scan-2" })).toContain(
    m.agent_context_reading(),
  );
  const stale = section({
    state: "stale",
    result: { ...fresh().result!, collectedAt: "2026-09-17T00:00:00.000Z" },
  });
  expect(stale).toContain(m.agent_context_stale());
});

test("an icon-only Refresh names itself", () => {
  const markup = section(fresh());
  expect(markup).toContain(`aria-label="${m.agent_context_refresh()}"`);
  expect(markup).not.toMatch(/<button[^>]*\sdisabled(?=[\s>])/);
});
