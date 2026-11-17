import { expect, test } from "bun:test";
import {
  activityInboxReadAllSchema,
  activityItemDoneSchema,
  activityItemReadSchema,
} from "#src/features/inbox/activity-inbox.schemas";

const artifactId = "00000000-0000-4000-8000-000000000001";

test("an artifact mark and a bulk bound refuse a time past any real clock", () => {
  const far = 8.64e15;
  expect(
    activityItemReadSchema.safeParse({ kind: "artifact", artifactId, throughAt: far }).success,
  ).toBe(false);
  expect(
    activityItemDoneSchema.safeParse({ kind: "artifact", artifactId, throughAt: far }).success,
  ).toBe(false);
  expect(activityInboxReadAllSchema.safeParse({ before: far }).success).toBe(false);
  expect(
    activityItemReadSchema.safeParse({ kind: "artifact", artifactId, throughAt: Date.now() })
      .success,
  ).toBe(true);
});
