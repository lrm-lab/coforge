import { expect, test } from "bun:test";
import {
  isValidMentionSelectorArray,
  mentionToken,
  MENTION_PATTERN,
  mentionsInContent,
  parseMentionSelector,
  replaceMentionTokens,
  resolveMentionTargets,
  splitCodeSpans,
  stripCodeSpans,
} from "./mentions";

test("parses a human mention selector as type user", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")).toEqual({
    type: "user",
    id: "11111111-1111-4111-8111-111111111111",
    name: "ada",
  });
});

test("parses an agent mention selector", () => {
  expect(parseMentionSelector("agent:22222222-2222-4222-8222-222222222222:helper")).toEqual({
    type: "agent",
    id: "22222222-2222-4222-8222-222222222222",
    name: "helper",
  });
});

test("lowercases the actor uuid", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id).toBe(
    parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id.toLowerCase(),
  );
});

test("rejects an unknown selector kind", () => {
  expect(parseMentionSelector("bot:11111111-1111-4111-8111-111111111111:ada")).toBeUndefined();
});

test("rejects a non-uuid actor id", () => {
  expect(parseMentionSelector("human:not-a-uuid:ada")).toBeUndefined();
});

test("rejects a handle with an uppercase character", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:Ada")).toBeUndefined();
});

test("rejects a handle over 128 characters", () => {
  const longHandle = "a".repeat(129);
  expect(
    parseMentionSelector(`human:11111111-1111-4111-8111-111111111111:${longHandle}`),
  ).toBeUndefined();
});

test("rejects a value with the wrong number of segments", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111")).toBeUndefined();
});

test("finds a plain @handle in content", () => {
  expect(mentionsInContent("hi @ada, please review").has("ada")).toBe(true);
});

test("code stripping keeps long prose and its mention boundaries exactly as written", () => {
  const body = "\u0000 中文😀 <tag> &lt; &#64; \\\r\n\u2028".repeat(3000) + "mail@ada @helper @ada";
  expect(stripCodeSpans(body)).toBe(body);
  expect([...mentionsInContent(body)]).toEqual(["helper", "ada"]);
  expect(stripCodeSpans("")).toBe("");
});

test("code stripping preserves fence precedence and LF-only inline boundaries", () => {
  expect(stripCodeSpans("@`before ```@ignored``` after`ada")).toBe("@ada");
  expect(stripCodeSpans("before `a\nb` after")).toBe("before `a\nb` after");
  expect(stripCodeSpans("before `a\rb\u2028c` end")).toBe("before  end");
  expect(stripCodeSpans("before `a\nb` after `a\rb\u2028c` end")).toBe(
    "before `a\nba\rb\u2028c` end",
  );
  expect(stripCodeSpans("before \\`@hidden` after @helper ```unfinished")).toBe(
    "before \\ after @helper `unfinished",
  );
});

test("ignores an @handle inside a fenced code block", () => {
  expect(mentionsInContent("```\n@ada\n```").has("ada")).toBe(false);
});

test("ignores an @handle inside inline code", () => {
  expect(mentionsInContent("see `@ada` in the log").has("ada")).toBe(false);
});

test("still finds an @handle outside a fenced code block in the same message", () => {
  const present = mentionsInContent("@ada please see:\n```\n@helper\n```");
  expect(present.has("ada")).toBe(true);
  expect(present.has("helper")).toBe(false);
});

test("MENTION_PATTERN is reusable across repeated matchAll calls (no shared lastIndex state)", () => {
  expect(mentionsInContent("@ada hi").has("ada")).toBe(true);
  expect(mentionsInContent("@bea hi").has("bea")).toBe(true);
  expect(mentionsInContent("@ada hi").has("ada")).toBe(true);
});

test("many repeated handles retain first-appearance order and the same handle boundaries", () => {
  const body = "mail@ada @@helper @Ada @é 中文@helper " + "@ada @helper @0_1 @a-2 ".repeat(500);
  expect([...mentionsInContent(body)]).toEqual(["helper", "ada", "0_1", "a-2"]);
});

test("code removal still joins surrounding handle text before scanning", () => {
  expect([...mentionsInContent("@`hidden`ada @hel```\n@ignored\n```per `@code` @ada")]).toEqual([
    "ada",
    "helper",
  ]);
});

test("each mention scan returns a fresh mutable set, including an empty result", () => {
  const empty = mentionsInContent("ordinary prose");
  empty.add("local");
  expect([...mentionsInContent("ordinary prose")]).toEqual([]);
  const found = mentionsInContent("@ada @helper");
  found.delete("ada");
  expect([...mentionsInContent("@ada @helper")]).toEqual(["ada", "helper"]);
});

test("mention scanning starts at the exported pattern cursor without changing it", () => {
  const previous = MENTION_PATTERN.lastIndex;
  try {
    MENTION_PATTERN.lastIndex = 5;
    expect([...mentionsInContent("@ada @helper")]).toEqual(["helper"]);
    expect(MENTION_PATTERN.lastIndex).toBe(5);
  } finally {
    MENTION_PATTERN.lastIndex = previous;
  }
});

test("isValidMentionSelectorArray accepts a well-formed array", () => {
  expect(
    isValidMentionSelectorArray([
      { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ada" },
      { type: "agent", id: "22222222-2222-4222-8222-222222222222", name: "helper" },
    ]),
  ).toBe(true);
});

test("isValidMentionSelectorArray rejects a non-array", () => {
  expect(isValidMentionSelectorArray("not-an-array")).toBe(false);
  expect(isValidMentionSelectorArray(undefined)).toBe(false);
});

test("isValidMentionSelectorArray rejects an array longer than the max", () => {
  const mention = { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ada" };
  expect(isValidMentionSelectorArray(Array.from({ length: 33 }, () => mention))).toBe(false);
  expect(isValidMentionSelectorArray(Array.from({ length: 32 }, () => mention))).toBe(true);
});

test("isValidMentionSelectorArray rejects a non-uuid id, an invalid type, or a bad handle", () => {
  expect(isValidMentionSelectorArray([{ type: "user", id: "not-a-uuid", name: "ada" }])).toBe(
    false,
  );
  expect(
    isValidMentionSelectorArray([
      { type: "human", id: "11111111-1111-4111-8111-111111111111", name: "ada" },
    ]),
  ).toBe(false);
  expect(
    isValidMentionSelectorArray([
      { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Ada" },
    ]),
  ).toBe(false);
});

const ADA = {
  key: "member-ada",
  type: "user" as const,
  id: "11111111-1111-4111-8111-111111111111",
  handle: "ada",
};
const HELPER = {
  key: "member-helper",
  type: "agent" as const,
  id: "22222222-2222-4222-8222-222222222222",
  handle: "helper",
};

test("mentionToken embeds the lowercased actor uuid with the selector kind word", () => {
  expect(mentionToken("user", ADA.id)).toBe(`<@human:${ADA.id}>`);
  expect(mentionToken("agent", HELPER.id.toUpperCase())).toBe(`<@agent:${HELPER.id}>`);
});

test("replaceMentionTokens resolves known tokens and keeps unknown ones intact", () => {
  const body = `hi <@human:${ADA.id}> and <@agent:${HELPER.id}> plus <@agent:33333333-3333-4333-8333-333333333333>`;
  const out = replaceMentionTokens(body, (type, id) =>
    type === "user" && id === ADA.id
      ? "@ada"
      : type === "agent" && id === HELPER.id
        ? "@helper"
        : undefined,
  );
  expect(out).toBe("hi @ada and @helper plus <@agent:33333333-3333-4333-8333-333333333333>");
});

test("splitCodeSpans preserves every byte and flags code", () => {
  const body = "a `b` c ```\nd @x\n``` e";
  const segments = splitCodeSpans(body);
  expect(segments.map((s) => s.text).join("")).toBe(body);
  expect(segments).toEqual([
    { text: "a ", code: false },
    { text: "`b`", code: true },
    { text: " c ", code: false },
    { text: "```\nd @x\n```", code: true },
    { text: " e", code: false },
  ]);
});

test("splitCodeSpans keeps empty and backtick-free bodies exactly as written", () => {
  expect(splitCodeSpans("")).toEqual([]);
  for (const body of [" \n\t", "普通消息 😀 <@task:7>", "\u0000 plain \r\n text "])
    expect(splitCodeSpans(body)).toEqual([{ text: body, code: false }]);
});

test("splitCodeSpans gives fenced blocks precedence over enclosing inline delimiters", () => {
  expect(splitCodeSpans("`before ```f``` after`")).toEqual([
    { text: "`before ", code: false },
    { text: "```f```", code: true },
    { text: " after`", code: false },
  ]);
});

test("splitCodeSpans retains escaped ticks, unmatched fences and line-boundary behavior", () => {
  expect(splitCodeSpans("before \\`x` after")).toEqual([
    { text: "before \\", code: false },
    { text: "`x`", code: true },
    { text: " after", code: false },
  ]);
  expect(splitCodeSpans("``` unfinished")).toEqual([
    { text: "``", code: true },
    { text: "` unfinished", code: false },
  ]);
  expect(splitCodeSpans("`a\nb`")).toEqual([{ text: "`a\nb`", code: false }]);
  expect(splitCodeSpans("`a\rb\u2028c`")).toEqual([{ text: "`a\rb\u2028c`", code: true }]);
});

test("binding UUIDs are case-insensitive while kind, handle and first matching target stay exact", () => {
  const id = "AABBCCDD-EEFF-4111-8111-AABBCCDDEEFF";
  const first = Object.freeze({
    key: "first",
    type: "user" as const,
    id: id.toLowerCase(),
    handle: "ada",
  });
  const targets = Object.freeze([
    Object.freeze({ key: "agent", type: "agent" as const, id, handle: "ada" }),
    Object.freeze({ key: "other", type: "user" as const, id, handle: "other" }),
    first,
    Object.freeze({ ...first, key: "second", id }),
  ]);
  const bindings = Object.freeze([
    Object.freeze({ type: "user" as const, id, name: "ada" }),
    Object.freeze({ type: "user" as const, id, name: "Ada" }),
  ]);
  const resolved = resolveMentionTargets([], targets, bindings);
  expect(resolved.mentions).toEqual([first]);
  expect(resolved.mentions[0]).toBe(first);
  expect(resolved.target("ada")).toBe(first);
  expect(resolved.target("other")).toBeUndefined();
  expect(resolved.target("Ada")).toBeUndefined();
});

test("bindings precede text mentions, dedupe by member and retain target object identities", () => {
  const targets = Object.freeze([Object.freeze(ADA), Object.freeze(HELPER)]);
  const bindings = Object.freeze([
    Object.freeze({ type: "agent" as const, id: HELPER.id, name: HELPER.handle }),
    Object.freeze({ type: "agent" as const, id: HELPER.id, name: HELPER.handle }),
    Object.freeze({ type: "user" as const, id: ADA.id, name: "unknown" }),
  ]);
  const handles = Object.freeze(["ada", "helper", "missing", "ada"]);
  const resolved = resolveMentionTargets(handles, targets, bindings);
  expect(resolved.mentions).toEqual([HELPER, ADA]);
  expect(resolved.mentions[0]).toBe(HELPER);
  expect(resolved.mentions[1]).toBe(ADA);
  expect(resolved.target("helper")).toBe(HELPER);
  expect(resolved.target("ada")).toBe(ADA);
  expect(resolved.target("missing")).toBeUndefined();
});

test("unbound text selects the first Agent sharing a handle, and an empty directory binds nobody", () => {
  const user = Object.freeze({ ...ADA, handle: "shared" });
  const firstAgent = Object.freeze({ ...HELPER, handle: "shared" });
  const secondAgent = Object.freeze({ ...firstAgent, key: "second-agent" });
  const resolved = resolveMentionTargets(["shared"], [user, firstAgent, secondAgent]);
  expect(resolved.mentions).toEqual([firstAgent]);
  expect(resolved.target("shared")).toBe(firstAgent);
  const empty = resolveMentionTargets(["ada"], [], [{ type: "user", id: ADA.id, name: "ada" }]);
  expect(empty.mentions).toEqual([]);
  expect(empty.target("ada")).toBeUndefined();
});
