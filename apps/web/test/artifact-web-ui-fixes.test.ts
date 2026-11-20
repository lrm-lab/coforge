import { expect, test } from "bun:test";
import type { ArtifactCommentView } from "#src/features/artifacts/artifact-comment-queries";
import {
  canSaveCommentEdit,
  findThreadForComment,
  groupThreads,
} from "#src/features/artifacts/artifact-comment-threads";
import {
  emptyGalleryState,
  initialFilters,
  type GalleryFilters,
} from "#src/features/artifacts/artifact-gallery-model";
import { canCopyEmbed } from "#src/features/artifacts/artifact-link-sharing";
import { clearReviewSearch } from "#src/features/artifacts/artifact-search";
import { nextPanelAfterCommentsToggle } from "#src/features/artifacts/use-comment-mode";

const author = { kind: "user" as const, id: "u1", name: "Ada" };

const makeComment = (id: string, extra: Partial<ArtifactCommentView> = {}): ArtifactCommentView =>
  ({
    id,
    author,
    version: 1,
    path: "index.md",
    anchor: { type: "text", data: { quote: id } },
    replyTo: null,
    body: id,
    createdAt: new Date("2026-11-19T00:00:00Z"),
    editedAt: null,
    reviewId: null,
    images: [],
    resolvedAt: null,
    resolvedBy: null,
    ...extra,
  }) as ArtifactCommentView;

test("B1: toggling the header comments button opens or closes only the comments panel independently of annotate mode", () => {
  expect(nextPanelAfterCommentsToggle(null)).toBe("comments");
  expect(nextPanelAfterCommentsToggle("pending")).toBe("comments");
  expect(nextPanelAfterCommentsToggle("files")).toBe("comments");
  expect(nextPanelAfterCommentsToggle("comments")).toBeNull();
});

test("B3: embed code action is available only when the viewer can enable link sharing or a public link is already on", () => {
  expect(canCopyEmbed({ linkAvailable: true, canChange: false, hasLink: false })).toBe(false);
  expect(canCopyEmbed({ linkAvailable: true, canChange: false, hasLink: true })).toBe(true);
  expect(canCopyEmbed({ linkAvailable: true, canChange: true, hasLink: false })).toBe(true);
  expect(canCopyEmbed({ linkAvailable: true, canChange: true, hasLink: true })).toBe(true);
  expect(canCopyEmbed({ linkAvailable: false, canChange: true, hasLink: false })).toBe(false);
  expect(canCopyEmbed({ linkAvailable: false, canChange: false, hasLink: false })).toBe(false);
});

test("B4: gallery empty state distinguishes Related to me from empty workspace, search, and other filters", () => {
  const withPatch = (patch: Partial<GalleryFilters>): GalleryFilters => ({
    ...initialFilters,
    ...patch,
  });
  expect(emptyGalleryState(initialFilters)).toEqual({ kind: "empty" });
  expect(emptyGalleryState(withPatch({ related: true }))).toEqual({ kind: "empty-related" });
  expect(emptyGalleryState(withPatch({ query: "report" }))).toEqual({
    kind: "no-match-search",
    clearKind: "search",
  });
  expect(emptyGalleryState(withPatch({ query: "report", related: true }))).toEqual({
    kind: "no-match-search",
    clearKind: "filters",
  });
  expect(emptyGalleryState(withPatch({ query: "report", scope: { kind: "workspace" } }))).toEqual({
    kind: "no-match-search",
    clearKind: "filters",
  });
  expect(emptyGalleryState(withPatch({ scope: { kind: "workspace" } }))).toEqual({
    kind: "no-match-filters",
    showSeeAll: false,
  });
  expect(emptyGalleryState(withPatch({ authorAgentIds: ["a1"], related: true }))).toEqual({
    kind: "no-match-filters",
    showSeeAll: true,
  });
});

test("B5: findThreadForComment locates resolved and open threads by root or reply id", () => {
  const groups = groupThreads([
    makeComment("open-root"),
    makeComment("open-reply", { replyTo: "open-root" }),
    makeComment("resolved-root", { resolvedAt: new Date("2026-11-19T01:00:00Z") }),
    makeComment("resolved-reply", { replyTo: "resolved-root" }),
  ]);
  expect(findThreadForComment(groups, "resolved-root")).toMatchObject({
    resolved: true,
    thread: { root: { id: "resolved-root" } },
  });
  expect(findThreadForComment(groups, "resolved-reply")).toMatchObject({
    resolved: true,
    thread: { root: { id: "resolved-root" } },
  });
  expect(findThreadForComment(groups, "open-root")).toMatchObject({
    resolved: false,
    thread: { root: { id: "open-root" } },
  });
  expect(findThreadForComment(groups, "open-reply")).toMatchObject({
    resolved: false,
    thread: { root: { id: "open-root" } },
  });
  expect(findThreadForComment(groups, "missing")).toBeNull();
});

test("B6: editing a comment or draft allows empty text when images are attached and blocks invalid mentions", () => {
  expect(
    canSaveCommentEdit({
      body: "   ",
      hasImages: true,
      tooLong: false,
      hasMentionError: false,
      saving: false,
    }),
  ).toBe(true);
  expect(
    canSaveCommentEdit({
      body: "   ",
      hasImages: false,
      tooLong: false,
      hasMentionError: false,
      saving: false,
    }),
  ).toBe(false);
  expect(
    canSaveCommentEdit({
      body: "Hi @outsider",
      hasImages: true,
      tooLong: false,
      hasMentionError: true,
      saving: false,
    }),
  ).toBe(false);
  expect(
    canSaveCommentEdit({
      body: "Valid",
      hasImages: false,
      tooLong: true,
      hasMentionError: false,
      saving: false,
    }),
  ).toBe(false);
  expect(
    canSaveCommentEdit({
      body: "Valid",
      hasImages: false,
      tooLong: false,
      hasMentionError: false,
      saving: true,
    }),
  ).toBe(false);
});

test("B7: clearReviewSearch removes only review while keeping version and comment params", () => {
  expect(
    clearReviewSearch({
      review: "11111111-1111-4111-8111-111111111111",
      comment: "22222222-2222-4222-8222-222222222222",
      version: 3,
    }),
  ).toEqual({
    review: undefined,
    comment: "22222222-2222-4222-8222-222222222222",
    version: 3,
  });
  expect(clearReviewSearch({ version: 2 })).toEqual({
    review: undefined,
    version: 2,
  });
});
