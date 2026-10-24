import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { formatSearchResults } from "#src/message-format";

function message(overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    sequence: 1,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target: "#general",
    body: "hello there",
    createdAt: "2026-09-07T10:00:00Z",
    attachments: [],
    ...overrides,
  };
}

test("formatSearchResults renders a query header, result blocks, and the context tip", () => {
  const output = formatSearchResults("release", { messages: [message({ body: "release plan" })] });
  expect(output).toContain('Search results for: "release" (1 result · truncated=false)');
  expect(output).toContain('<result ref="msg:aaaaaaaa-0000-4000-8000-000000000001">');
  expect(output).toContain("Source: #general");
  expect(output).toContain("Sender: user:ada");
  expect(output).toContain("Time: 2026-09-07 10:00:00Z");
  expect(output).toContain("<preview>\n<match>release</match> plan\n</preview>");
  expect(output).toContain(
    'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.',
  );
});

test("formatSearchResults pluralizes and uses a filter-only header when no query is given", () => {
  expect(formatSearchResults("", { messages: [message()] })).toContain(
    "Filtered message results (1 result · truncated=false)",
  );
  expect(formatSearchResults("", { messages: [message(), message({ id: "bbbbbbbb" })] })).toContain(
    "Filtered message results (2 results · truncated=false)",
  );
});

test("formatSearchResults reports no results plainly", () => {
  expect(formatSearchResults("release", { messages: [] })).toBe("No search results.");
});

test("formatSearchResults reports a known truncated page and a copyable next page", () => {
  const output = formatSearchResults(
    "release",
    { messages: [message({ body: "release plan" })], hasMore: true },
    { limit: 1, offset: 2, target: "#general", sender: "@ada", sort: "recent" },
  );
  expect(output).toContain("(1 result · truncated=true)");
  expect(output).toContain(
    'Next page: coforge message search --query "release" --target "#general" --sender "@ada" --sort recent --limit 1 --offset 3',
  );
});

test("formatSearchResults marks a full page unknown when the server gives no continuation flag", () => {
  const output = formatSearchResults("release", { messages: [message()] }, { limit: 1 });
  expect(output).toContain("(1 result · truncated=unknown)");
  expect(output).toContain(
    'Next page: coforge message search --query "release" --limit 1 --offset 1',
  );
});
