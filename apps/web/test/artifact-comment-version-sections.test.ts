import { expect, test } from "bun:test";
import type { ArtifactCommentView } from "#src/features/artifacts/artifact-comment-queries";
import { groupThreads, versionSections } from "#src/features/artifacts/artifact-comment-threads";

const author = { kind: "user" as const, id: "u1", name: "Ada" };

const comment = (
  id: string,
  version: number,
  path: string | null,
  extra: Partial<ArtifactCommentView> = {},
): ArtifactCommentView =>
  ({
    id,
    author,
    version,
    path,
    anchor: path === null ? null : { type: "text", data: { quote: id } },
    replyTo: null,
    body: id,
    createdAt: new Date(`2026-11-17T00:00:0${id.length}Z`),
    editedAt: null,
    reviewId: null,
    images: [],
    resolvedAt: null,
    resolvedBy: null,
    ...extra,
  }) as ArtifactCommentView;

const ids = (sections: ReturnType<typeof versionSections>) =>
  sections.map(({ version, whole, anchored }) => ({
    version,
    whole: whole.map((thread) => thread.root.id),
    anchored: anchored.map((thread) => thread.root.id),
  }));

test("open threads are split by the version they were written on, the shown one first, then newest", () => {
  const groups = groupThreads([
    comment("a", 1, "plan.md"),
    comment("b", 3, "plan.md"),
    comment("c", 2, null),
    comment("d", 2, "plan.md"),
    comment("e", 3, null),
  ]);
  expect(ids(versionSections(groups, 2))).toEqual([
    { version: 2, whole: ["c"], anchored: ["d"] },
    { version: 3, whole: ["e"], anchored: ["b"] },
    { version: 1, whole: [], anchored: ["a"] },
  ]);
});

test("the shown version has a section only when it has threads", () => {
  const groups = groupThreads([comment("a", 1, "plan.md"), comment("b", 1, null)]);
  expect(ids(versionSections(groups, 4))).toEqual([{ version: 1, whole: ["b"], anchored: ["a"] }]);
});

test("resolved threads stay out of the version sections", () => {
  const groups = groupThreads([
    comment("a", 1, "plan.md", { resolvedAt: new Date("2026-11-17T01:00:00Z") }),
    comment("b", 1, "plan.md"),
  ]);
  expect(ids(versionSections(groups, 1))).toEqual([{ version: 1, whole: [], anchored: ["b"] }]);
  expect(groups.resolved.map((thread) => thread.root.id)).toEqual(["a"]);
});
