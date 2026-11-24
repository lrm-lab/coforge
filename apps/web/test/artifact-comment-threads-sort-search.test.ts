import { describe, expect, test } from "bun:test";

import type { ArtifactCommentView } from "#src/features/artifacts/artifact-comment-queries";
import {
  filterCommentGroups,
  groupThreads,
  matchesCommentSearch,
  planCommentFocus,
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

describe("planCommentFocus", () => {
  const groups = groupThreads([
    makeComment("a1", { body: "Alpha topic" }),
    makeComment("b1", { body: "Beta topic" }),
    makeComment("b1-reply", { replyTo: "b1", body: "Beta reply" }),
    makeComment("c1", {
      body: "Gamma resolved",
      resolvedAt: new Date("2026-11-20T12:00:00Z"),
    }),
  ]);
  const alphaFiltered = filterCommentGroups(groups, "Alpha");
  const gammaFiltered = filterCommentGroups(groups, "Gamma");

  test("keeps search and focuses directly when target matches current search", () => {
    expect(
      planCommentFocus({
        focus: "a1",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "focus", targetId: "a1" });
  });

  test("clears search when a loaded open thread or reply is filtered out", () => {
    expect(
      planCommentFocus({
        focus: "b1",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "prepare", clearSearch: true, openResolved: false });

    expect(
      planCommentFocus({
        focus: "b1-reply",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "prepare", clearSearch: true, openResolved: false });

    expect(
      planCommentFocus({
        focus: "b1-reply",
        groups,
        filteredGroups: groups,
        searching: false,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "focus", targetId: "b1" });
  });

  test("clears search and expands resolved when a filtered-out resolved thread is targeted", () => {
    expect(
      planCommentFocus({
        focus: "c1",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "prepare", clearSearch: true, openResolved: true });

    expect(
      planCommentFocus({
        focus: "c1",
        groups,
        filteredGroups: groups,
        searching: false,
        resolvedOpen: true,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "focus", targetId: "c1" });
  });

  test("keeps search while expanding resolved when resolved target already matches search", () => {
    expect(
      planCommentFocus({
        focus: "c1",
        groups,
        filteredGroups: gammaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "prepare", clearSearch: false, openResolved: true });
  });

  test("does not clear search for unloaded or out-of-scope targets", () => {
    expect(
      planCommentFocus({
        focus: "missing-id",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "focus", targetId: "missing-id" });
  });

  test("returns none when focus is null or pending review is showing", () => {
    expect(
      planCommentFocus({
        focus: null,
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: false,
      }),
    ).toEqual({ action: "none" });

    expect(
      planCommentFocus({
        focus: "b1",
        groups,
        filteredGroups: alphaFiltered,
        searching: true,
        resolvedOpen: false,
        reviewActive: false,
        pendingReview: true,
      }),
    ).toEqual({ action: "none" });
  });
});
