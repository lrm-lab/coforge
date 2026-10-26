import { expect, test } from "bun:test";
import type { AgentAttachmentComment } from "@lrm/coforge-sdk/agent";
import {
  formatAttachmentComments,
  parseAttachmentCommentsArgs,
  runAttachmentComments,
} from "#src/attachment-comments";
import { parseArgs } from "../index";

const ID = "9f0c5a52-1111-4222-8333-444455556666";
const MSG = "3f4b1fd4-aaaa-4bbb-8ccc-000000000001";

const comment = (overrides: Partial<AgentAttachmentComment> = {}): AgentAttachmentComment => ({
  id: MSG,
  sequence: 4,
  senderKind: "human",
  senderName: "Ada",
  senderHandle: "ada",
  body: "typo here",
  createdAt: "2026-10-25T11:00:00.000Z",
  reactions: [],
  anchor: null,
  resolved: false,
  ...overrides,
});

const page = (comments: AgentAttachmentComment[], hasOlder = false) => ({
  ok: true as const,
  attachmentId: ID,
  viewer: { canComment: true },
  comments,
  hasOlder,
});

const lineOf = (c: AgentAttachmentComment) => formatAttachmentComments(page([c])).split("\n")[1]!;

test("a comment line shows the 13-character id, UTC time, sender type, anchor and sender", () => {
  expect(lineOf(comment({ anchor: { type: "lines", data: { start: 3, end: 3 } } }))).toStartWith(
    `[msg=${MSG.slice(0, 13)} time=2026-10-25 11:00:00Z type=human] [anchor: L3] @ada: `,
  );
});

test("anchors read as a section, lines, rows or a quote", () => {
  const anchor = (type: string, data: Record<string, unknown>) =>
    lineOf(comment({ anchor: { type, data } }));
  expect(anchor("md-section", { headingTitle: "Install" })).toContain("[anchor: § Install]");
  expect(anchor("lines", { start: 3, end: 5 })).toContain("[anchor: L3–5]");
  expect(anchor("csv-rows", { start: 2, end: 2 })).toContain("[anchor: rows 2]");
  expect(anchor("csv-rows", { start: 2, end: 9 })).toContain("[anchor: rows 2–9]");
  expect(anchor("video-timestamp", {})).toContain("[anchor: video-timestamp]");
});

test("an HTML quote is cut at 60 characters with an ellipsis, and a short one is kept", () => {
  const long = "x".repeat(80);
  expect(lineOf(comment({ anchor: { type: "html-region", data: { quote: long } } }))).toContain(
    `[anchor: ${"x".repeat(60)}…]`,
  );
  expect(
    lineOf(comment({ anchor: { type: "html-region", data: { quote: "short  one" } } })),
  ).toContain("[anchor: short one]");
});

test("a resolved comment carries ✅ and none when unresolved", () => {
  expect(lineOf(comment({ resolved: true }))).toContain("] ✅ @ada");
  expect(lineOf(comment())).not.toContain("✅");
});

test("the page names the full id and, when older comments remain, how to read them", () => {
  const text = formatAttachmentComments(page([comment()], true));
  expect(text).toContain(`## Comments on attachment ${ID} (1)`);
  expect(text).toContain(`More: coforge attachment comments ${ID} --before 4`);
  expect(text).toContain(`Read: coforge message read --target 'attachment:${ID}'`);
  expect(text).toContain(`Reply: coforge message send --target 'attachment:${ID}:${MSG}'`);
});

test("an attachment without comments says so", () => {
  expect(formatAttachmentComments(page([])).split("\n")[0]).toBe(
    `No comments on attachment ${ID}.`,
  );
});

test("a viewer who cannot comment is told why", () => {
  const text = formatAttachmentComments({
    ...page([comment()]),
    viewer: { canComment: false, reason: "archived" },
  });
  expect(text).toContain("You cannot comment on this attachment (archived).");
});

test("arguments: positional or --id, limit, before and --json", () => {
  expect(parseAttachmentCommentsArgs([ID, "--limit", "5", "--before", "9", "--json"])).toEqual({
    command: "attachment-comments",
    attachmentId: ID,
    limit: 5,
    before: 9,
    json: true,
  });
  expect(parseAttachmentCommentsArgs(["--id", ID])).toMatchObject({ attachmentId: ID });
  expect(parseArgs(["attachment", "comments", ID])).toMatchObject({
    command: "attachment-comments",
    attachmentId: ID,
  });
});

test("arguments: a bad id, limit or before is INVALID_ARG", () => {
  for (const args of [
    [],
    ["not-a-uuid"],
    [ID, "--id", ID],
    [ID, "--limit", "abc"],
    [ID, "--limit", "0"],
    [ID, "--limit", "101"],
    [ID, "--limit", "1.5"],
    [ID, "--before", "0"],
    [ID, "--before"],
  ])
    expect(() => parseAttachmentCommentsArgs(args)).toThrow(
      expect.objectContaining({ code: "INVALID_ARG" }),
    );
});

test("the printed id feeds attachment view", () => {
  expect(parseArgs(["attachment", "view", ID, "--output", "/tmp/f"])).toMatchObject({
    attachmentId: ID,
  });
});

test("--json returns the response as is", async () => {
  const response = page([comment()]);
  const seen: unknown[] = [];
  const result = await runAttachmentComments(
    async (request) => {
      seen.push(request);
      return response;
    },
    { command: "attachment-comments", attachmentId: ID, limit: 2, json: true },
  );
  expect(result).toBe(response);
  expect(seen).toEqual([{ attachmentId: ID, limit: 2, before: undefined }]);
});
