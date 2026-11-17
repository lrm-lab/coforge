import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactViewerPositions } from "#src/server/artifacts/artifact-viewer-positions.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let clock = 1_000_000;
let positions: ArtifactViewerPositions;
beforeAll(async () => {
  f = await commentsFixture("vp");
  positions = new ArtifactViewerPositions(f.db, f.artifacts.reads, () => new Date(clock));
});
afterAll(() => f.cleanup());

const position = (artifactId: string, userId: string) =>
  f.db.artifactViewerPosition.findUnique({
    where: { artifactId_userId: { artifactId, userId } },
  });
const open = (artifactId: string, userId: string, version?: number) =>
  positions.open({ workspaceId: f.workspaceId, artifactId, userId, version });

test("opening records the time and the version seen, and never rewinds the version", async () => {
  const artifact = await f.make("Opened");
  await f.pushText(artifact, f.agents.writer, "two\n");
  expect(await position(artifact, f.alice)).toBeNull();

  await open(artifact, f.alice);
  expect(await position(artifact, f.alice)).toMatchObject({ seenVersion: 2 });

  clock += 5_000;
  await open(artifact, f.alice, 1);
  const again = await position(artifact, f.alice);
  expect(again?.seenVersion).toBe(2);
  expect(again?.openedAt.getTime()).toBe(clock);
});

test("a person who cannot read the artifact records nothing", async () => {
  const artifact = await f.make("Closed", undefined, { target: `#${f.privateChannel}` });
  await expect(open(artifact, f.bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await position(artifact, f.bob)).toBeNull();
});

const roster = (artifactId: string, viewing?: string[]) =>
  positions.roster({ workspaceId: f.workspaceId, artifactId, userId: f.alice, viewing });

test("the roster names who opened it and who has not seen the latest version", async () => {
  const artifact = await f.make("Roster");
  await open(artifact, f.alice);
  await open(artifact, f.bob);
  await f.pushText(artifact, f.agents.writer, "two\n");
  await open(artifact, f.alice);

  const read = await roster(artifact);
  expect(read).not.toHaveProperty("viewingNow");
  expect(read.currentVersion).toBe(2);
  expect(read.seen.map(({ name, seenVersion }) => [name, seenVersion]).sort()).toEqual([
    ["Alice", 2],
    ["Bob", 1],
  ]);
  expect(read.behind).toBe(1);
});

test("the people viewing now are named even past the fifty latest openers, strangers never", async () => {
  const artifact = await f.make("Busy");
  await open(artifact, f.bob);
  clock += 1_000;
  const crowd = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      f.db.user.create({
        data: {
          username: `vp-crowd-${index}-${artifact.slice(0, 8)}`,
          displayName: `Crowd ${index}`,
        },
      }),
    ),
  );
  const stranger = crowd.pop()!;
  await f.db.artifactViewerPosition.createMany({
    data: [...crowd, { id: f.alice }].map((user) => ({
      artifactId: artifact,
      userId: user.id,
      openedAt: new Date(clock),
      seenVersion: 1,
    })),
  });
  try {
    expect((await roster(artifact)).seen.map((person) => person.userId)).not.toContain(f.bob);
    const read = await roster(artifact, [f.bob, stranger.id]);
    expect(read.seen.find((person) => person.userId === f.bob)).toMatchObject({ name: "Bob" });
    expect(read.seen.map((person) => person.userId)).not.toContain(stranger.id);
  } finally {
    await f.db.artifactViewerPosition.deleteMany({ where: { artifactId: artifact } });
    await f.db.user.deleteMany({
      where: { id: { in: [...crowd, stranger].map((user) => user.id) } },
    });
  }
});
