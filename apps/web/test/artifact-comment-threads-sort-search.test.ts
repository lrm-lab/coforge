import { describe, expect, test } from "bun:test";

import type { ArtifactCommentView } from "#src/features/artifacts/artifact-comment-queries";
import {
  filterCommentGroups,
  groupThreads,
  matchesCommentSearch,
  sortThreadsByUpdated,
  threadUpdatedAt,
} from "#src/features/artifacts/artifact-comment-threads";

const makeComment = (
  id: string,
  overrides: Partial<Exclude<ArtifactCommentView, { deleted: true }>> = {},
): ArtifactCommentView =>
  ({
    id,
    author: { kind: "user", name: "Ada Lovelace" },
    version: 2,
    path: "index.html",
    anchor: { type: "text", data: { quote: "highlighted text" } },
    replyTo: null,
    body: `body for ${id}`,
    createdAt: new Date("2026-11-20T10:00:00Z"),
    editedAt: null,
    reviewId: null,
    images: [],
    resolvedAt: null,
    resolvedBy: null,
    canResolve: true,
    mine: true,
    ...overrides,
  }) as ArtifactCommentView;

describe("artifact comment search", () => {
  test("matches root body, reply body, author name, file path, and anchor quote case-insensitively", () => {
    const groups = groupThreads([
      makeComment("c1", {
        body: "Fix chart axis spacing",
        author: { kind: "user", name: "Lin Xia" },
        path: "charts/latency.html",
        anchor: { type: "element", data: { selector: "#chart", quote: "Cumulative Failures" } },
      }),
      makeComment("r1", {
        replyTo: "c1",
        body: "Updated padding in v2",
        author: { kind: "agent", name: "Dax" },
      }),
    ]);
    const thread = groups.anchored[0]!;

    expect(matchesCommentSearch(thread, "")).toBe(true);
    expect(matchesCommentSearch(thread, "   ")).toBe(true);
    expect(matchesCommentSearch(thread, "AXIS")).toBe(true);
    expect(matchesCommentSearch(thread, "padding")).toBe(true);
    expect(matchesCommentSearch(thread, "dax")).toBe(true);
    expect(matchesCommentSearch(thread, "latency.html")).toBe(true);
    expect(matchesCommentSearch(thread, "cumulative")).toBe(true);
    expect(matchesCommentSearch(thread, "nonexistent")).toBe(false);
  });

  test("filters whole, anchored, and resolved groups independently", () => {
    const groups = groupThreads([
      makeComment("w1", { path: null, anchor: null, body: "Overall layout looks crisp" }),
      makeComment("a1", { body: "Button contrast too low" }),
      makeComment("res1", {
        body: "Contrast fixed in v2",
        resolvedAt: new Date("2026-11-20T12:00:00Z"),
      }),
    ]);

    const filtered = filterCommentGroups(groups, "contrast");
    expect(filtered.whole).toHaveLength(0);
    expect(filtered.anchored.map((t) => t.root.id)).toEqual(["a1"]);
    expect(filtered.resolved.map((t) => t.root.id)).toEqual(["res1"]);
  });
});

describe("artifact comment last-updated sorting", () => {
  test("uses latest reply or edit timestamp and sorts descending", () => {
    const groups = groupThreads([
      makeComment("t1", { createdAt: new Date("2026-11-20T09:00:00Z") }),
      makeComment("t1-reply", {
        replyTo: "t1",
        createdAt: new Date("2026-11-20T15:00:00Z"),
      }),
      makeComment("t2", {
        createdAt: new Date("2026-11-20T11:00:00Z"),
        editedAt: new Date("2026-11-20T14:00:00Z"),
      }),
      makeComment("t3", { createdAt: new Date("2026-11-20T12:00:00Z") }),
    ]);

    const sorted = sortThreadsByUpdated(groups.anchored);
    expect(sorted.map((thread) => thread.root.id)).toEqual(["t1", "t2", "t3"]);
    expect(threadUpdatedAt(sorted[0]!)).toBe(new Date("2026-11-20T15:00:00Z").getTime());
    expect(threadUpdatedAt(sorted[1]!)).toBe(new Date("2026-11-20T14:00:00Z").getTime());
  });
});
