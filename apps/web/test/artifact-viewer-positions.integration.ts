import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryArtifactViewing } from "#src/server/artifacts/artifact-viewing.server";
import { ArtifactViewerPositions } from "#src/server/artifacts/artifact-viewer-positions.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let clock = 1_000_000;
const viewing = new MemoryArtifactViewing(() => clock);
let positions: ArtifactViewerPositions;
beforeAll(async () => {
  f = await commentsFixture("vp");
  positions = new ArtifactViewerPositions(f.db, f.artifacts.reads, viewing, () => new Date(clock));
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

test("the roster names who is viewing now and who has not seen the latest version", async () => {
  const artifact = await f.make("Roster");
  await open(artifact, f.alice);
  await open(artifact, f.bob);
  await f.pushText(artifact, f.agents.writer, "two\n");
  await open(artifact, f.alice);

  await positions.heartbeat({ workspaceId: f.workspaceId, artifactId: artifact, userId: f.alice });
  const roster = await positions.roster({
    workspaceId: f.workspaceId,
    artifactId: artifact,
    userId: f.alice,
  });
  expect(roster.currentVersion).toBe(2);
  expect(roster.viewingNow.map((person) => person.name).sort()).toEqual(["Alice", "Bob"]);
  expect(roster.seen.map(({ name, seenVersion }) => [name, seenVersion]).sort()).toEqual([
    ["Alice", 2],
    ["Bob", 1],
  ]);
  expect(roster.behind).toBe(1);

  clock += 120_000;
  const later = await positions.roster({
    workspaceId: f.workspaceId,
    artifactId: artifact,
    userId: f.alice,
  });
  expect(later.viewingNow).toEqual([]);
});
