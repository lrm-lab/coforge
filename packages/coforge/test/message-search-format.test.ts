import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { formatSearchResults } from "#src/search-format";

process.env.TZ = "Asia/Shanghai";

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
  const output = formatSearchResults("release", {
    messages: [message({ body: "release plan" })],
    hasMore: false,
  });
  expect(output).toContain('Search results for: "release" (1 result · truncated=false)');
  expect(output).toContain('<result ref="msg:aaaaaaaa-0000-4000-8000-000000000001">');
  expect(output).toContain("Source: #general");
  expect(output).toContain("Sender: user:ada");
  expect(output).toContain("Time: 2026-09-07 18:00:00 +08:00");
  expect(output).toContain("<preview>\n<match>release</match> plan\n</preview>");
  expect(
    output.endsWith(
      'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.',
    ),
  ).toBe(true);
});

test("formatSearchResults shows a result's task between its time and preview", () => {
  const output = formatSearchResults("release", {
    messages: [
      message({
        task: {
          number: 7,
          status: "in_progress",
          owner: { handle: "ada", deleted: false },
        } as AgentMessageRecord["task"],
      }),
    ],
    hasMore: false,
  });
  expect(output).toContain(
    "Time: 2026-09-07 18:00:00 +08:00\n[task #7 status=in_progress owner=@ada]\n\n<preview>",
  );
});

test("formatSearchResults pluralizes and uses a filter-only header when no query is given", () => {
  expect(formatSearchResults("", { messages: [message()], hasMore: false })).toContain(
    "Filtered message results (1 result · truncated=false)",
  );
  expect(
    formatSearchResults("", { messages: [message(), message({ id: "bbbbbbbb" })], hasMore: false }),
  ).toContain("Filtered message results (2 results · truncated=false)");
});

test("formatSearchResults reports no results with how complete the search was", () => {
  expect(formatSearchResults("release", { messages: [], hasMore: false })).toBe(
    "No search results. (truncated=false)",
  );
  expect(formatSearchResults("release", { messages: [] })).toBe(
    "No search results. (truncated=unknown · server did not report hasMore)",
  );
});

test("formatSearchResults continues a recent search with its cursor", () => {
  const output = formatSearchResults(
    "release",
    { messages: [message({ body: "release plan" })], hasMore: true, nextCursor: "abc_-9" },
    { limit: 1, target: "#general", sender: "@ada", sort: "recent", after: "2026-09-01T00:00:00Z" },
  );
  expect(output).toContain(
    "(1 result · truncated=true · more results exist; the Next page command below continues exactly after this page)",
  );
  expect(output.split("\n").at(-1)).toBe(
    'Next page: coforge message search --query "release" --target "#general" --sender "@ada" --sort recent --after "2026-09-01T00:00:00Z" --limit 1 --cursor "abc_-9"',
  );
  expect(output).not.toContain("--offset");
});

test("formatSearchResults pages a relevance search with --offset", () => {
  const output = formatSearchResults(
    "release",
    { messages: [message()], hasMore: true },
    { limit: 1, offset: 2 },
  );
  expect(output).toContain(
    "(1 result · truncated=true · more results exist, page with --offset 3)",
  );
  expect(output.split("\n").at(-1)).toBe(
    'Next page: coforge message search --query "release" --limit 1 --offset 3',
  );
});

test("formatSearchResults steps a recent search without a cursor back with --before", () => {
  const output = formatSearchResults(
    "",
    { messages: [message({ createdAt: "2026-09-07T10:00:00.123Z" })], hasMore: true },
    { sort: "recent", target: "#general" },
  );
  expect(output).toContain(
    "more results exist, page with --before 2026-09-07T10:00:00.123Z (pages OLDER only; NOT a complete traversal:",
  );
  expect(output).toContain('--sort recent --before "2026-09-07T10:00:00.123Z"');
});

test("formatSearchResults words an incomplete search as older messages not searched", () => {
  const output = formatSearchResults(
    "release",
    {
      messages: [message()],
      hasMore: true,
      nextCursor: "c1",
      incomplete: true,
      searchedMessages: 5000,
      searchedThrough: "2026-08-01T00:00:00Z",
    },
    { limit: 1, sort: "recent" },
  );
  expect(output).toContain(
    "incomplete=true · stopped after reading 5000 messages, back to 2026-08-01 08:00:00 +08:00; older messages were not searched, so these are NOT all the matches",
  );
  expect(output).toContain(
    'Next (search older messages): coforge message search --query "release" --sort recent --limit 1 --cursor "c1"\nOr narrow the search: add --target \'#<channel>\' or --sender <handle>.',
  );
  const narrowed = formatSearchResults(
    "release",
    { messages: [message()], hasMore: true, nextCursor: "c1", incomplete: true },
    { target: "#general" },
  );
  expect(narrowed).toContain("incomplete=true · older messages were not searched");
  expect(narrowed).not.toContain("Or narrow the search");
});

test("formatSearchResults reports an incomplete search with no matches", () => {
  expect(formatSearchResults("release", { messages: [], incomplete: true, hasMore: false })).toBe(
    "Search incomplete: no matches in the messages searched so far. Older messages were not searched, so this does NOT mean no message matches. (incomplete=true)",
  );
});

test("formatSearchResults reports an empty page that still says more follows", () => {
  expect(formatSearchResults("release", { messages: [], hasMore: true })).toBe(
    "No search results. (truncated=true · more results exist)",
  );
});
