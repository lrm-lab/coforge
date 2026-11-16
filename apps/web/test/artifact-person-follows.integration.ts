import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactPersonFollows } from "#src/server/artifacts/artifact-person-follows.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let follows: ArtifactPersonFollows;
beforeAll(async () => {
  f = await commentsFixture("pf");
  follows = new ArtifactPersonFollows(f.db, f.artifacts.reads);
});
afterAll(() => f.cleanup());

const scope = (artifactId: string, userId: string) => ({
  workspaceId: f.workspaceId,
  artifactId,
  userId,
});

test("a person follows, unfollows and is read as they left it", async () => {
  const artifact = await f.make("Followed by people");
  expect(await follows.read(scope(artifact, f.bob))).toBe(false);
  expect(await follows.set({ ...scope(artifact, f.bob), following: true })).toBe(true);
  expect(await follows.read(scope(artifact, f.bob))).toBe(true);
  expect(await follows.read(scope(artifact, f.alice))).toBe(false);
  expect(await follows.set({ ...scope(artifact, f.bob), following: true })).toBe(true);
  expect(await follows.set({ ...scope(artifact, f.bob), following: false })).toBe(false);
  expect(await follows.read(scope(artifact, f.bob))).toBe(false);
  const row = await f.db.artifactFollow.findUnique({
    where: { artifactId_userId: { artifactId: artifact, userId: f.bob } },
  });
  expect(row).toMatchObject({ following: false, agentId: null });
  expect(row?.unfollowedAt).toBeInstanceOf(Date);
});

test("following again forgets the unfollow", async () => {
  const artifact = await f.make("Back again");
  await follows.set({ ...scope(artifact, f.bob), following: false });
  await follows.set({ ...scope(artifact, f.bob), following: true });
  expect(
    await f.db.artifactFollow.findUnique({
      where: { artifactId_userId: { artifactId: artifact, userId: f.bob } },
      select: { following: true, unfollowedAt: true },
    }),
  ).toEqual({ following: true, unfollowedAt: null });
});

test("someone who cannot read the artifact cannot follow it", async () => {
  const artifact = await f.make("Hidden", undefined, { target: `#${f.privateChannel}` });
  await expect(follows.set({ ...scope(artifact, f.bob), following: true })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(follows.read(scope(artifact, f.bob))).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a person's follow does not make an Agent follower, nor does it tell anyone", async () => {
  const artifact = await f.make("People only");
  await follows.set({ ...scope(artifact, f.bob), following: true });
  expect(
    await f.db.artifactFollow.count({ where: { artifactId: artifact, agentId: { not: null } } }),
  ).toBe(1);
  expect(
    (await f.noticesOf(f.agents.reader)).filter((n) => n.externalEventId.startsWith(artifact)),
  ).toHaveLength(0);
});
