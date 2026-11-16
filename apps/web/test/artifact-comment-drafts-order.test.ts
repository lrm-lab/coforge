import { expect, test } from "bun:test";
import {
  inCreationOrder,
  type CommentDraftView,
} from "#src/features/artifacts/artifact-comment-drafts-queries";

const draft = (id: string, createdAt: string) =>
  ({ id, createdAt: new Date(createdAt) }) as unknown as CommentDraftView;

test("a restored draft takes its place by creation time, ties by id, as the server orders them", () => {
  const held = [
    draft("b", "2026-11-17T10:00:02Z"),
    draft("c", "2026-11-17T10:00:03Z"),
    draft("a2", "2026-11-17T10:00:01Z"),
    draft("a1", "2026-11-17T10:00:01Z"),
  ];
  expect(inCreationOrder(held).map(({ id }) => id)).toEqual(["a1", "a2", "b", "c"]);
});
