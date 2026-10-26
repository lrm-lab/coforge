import { expect, test } from "bun:test";
import {
  decodeAgentAttachmentCommentsErrorResponse,
  decodeAgentAttachmentCommentsResponse,
} from "./attachment-comments";

const comment = (overrides: Record<string, unknown> = {}) => ({
  id: "3f4b1fd4-aaaa-4bbb-8ccc-000000000001",
  sequence: 4,
  senderKind: "human",
  senderName: "Ada",
  senderHandle: "ada",
  body: "typo here",
  createdAt: "2026-10-25T11:00:00.000Z",
  reactions: [{ emoji: "✅", count: 1 }],
  anchor: { type: "lines", data: { start: 3, end: 5 } },
  resolved: true,
  ...overrides,
});

const response = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  attachmentId: "a",
  viewer: { canComment: false, canResolve: false, reason: "archived" },
  comments: [comment()],
  hasOlder: false,
  ...overrides,
});

test("decodes a page of comments with and without an anchor", () => {
  const decoded = decodeAgentAttachmentCommentsResponse(
    response({ comments: [comment(), comment({ anchor: null, resolved: false })] }),
  );
  expect(decoded.comments.map((c) => c.anchor?.type ?? null)).toEqual(["lines", null]);
  expect(decoded.viewer).toEqual({ canComment: false, canResolve: false, reason: "archived" });
});

test("refuses a response whose comment or viewer is malformed", () => {
  for (const bad of [
    response({ comments: [comment({ senderKind: "user" })] }),
    response({ comments: [comment({ resolved: "yes" })] }),
    response({ comments: [comment({ anchor: { type: "lines" } })] }),
    response({ viewer: { canComment: true, reason: "gone" } }),
    response({ hasOlder: undefined }),
    { ...response(), ok: false },
  ])
    expect(() => decodeAgentAttachmentCommentsResponse(bad)).toThrow(
      "invalid Agent attachment comments response",
    );
});

test("decodes only the documented error codes", () => {
  expect(
    decodeAgentAttachmentCommentsErrorResponse({ ok: false, errorCode: "NOT_FOUND", error: "x" }),
  ).toEqual({ ok: false, errorCode: "NOT_FOUND", error: "x" });
  expect(
    decodeAgentAttachmentCommentsErrorResponse({ ok: false, errorCode: "BOOM", error: "x" }),
  ).toBeUndefined();
});

test("requires a resolve capability and preserves only an executable checkmark action", () => {
  const viewer = {
    canComment: true,
    canResolve: true,
    resolveAction: { type: "reaction" as const, emoji: "✅" as const },
  };
  expect(decodeAgentAttachmentCommentsResponse(response({ viewer })).viewer).toEqual(viewer);
  for (const bad of [
    { canComment: true },
    { canComment: true, canResolve: true },
    { canComment: false, canResolve: false, resolveAction: viewer.resolveAction },
    { ...viewer, resolveAction: { type: "reaction", emoji: "👍" } },
    { ...viewer, resolveAction: { type: "resolve", emoji: "✅" } },
    { ...viewer, canResolve: "true" },
  ])
    expect(() => decodeAgentAttachmentCommentsResponse(response({ viewer: bad }))).toThrow();
});
