import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactRenames } from "#src/server/artifacts/artifact-rename.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let renames: ArtifactRenames;
beforeAll(async () => {
  f = await commentsFixture("rn");
  renames = new ArtifactRenames(f.db, f.artifacts.reads, f.notices);
});
afterAll(() => f.cleanup());

const rename = (artifactId: string, userId: string, title: string) =>
  renames.rename({ workspaceId: f.workspaceId, artifactId, userId, title });
const stored = (artifactId: string) =>
  f.db.artifact.findUniqueOrThrow({
    where: { id: artifactId },
    select: {
      title: true,
      currentVersion: true,
      versions: { select: { number: true, title: true } },
    },
  });

test("a rename changes the title and makes no version", async () => {
  const artifact = await f.make("Old name");
  const result = await rename(artifact, f.alice, "  New name  ");
  expect(result).toMatchObject({ title: "New name", from: "Old name" });
  const row = await stored(artifact);
  expect(row).toMatchObject({ title: "New name", currentVersion: 1 });
  expect(row.versions).toEqual([{ number: 1, title: "New name" }]);
});

test("a plain reader is refused; a Workspace admin may rename", async () => {
  const artifact = await f.make("Managed");
  await expect(rename(artifact, f.bob, "Mine")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect((await stored(artifact)).title).toBe("Managed");
  await f.db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: f.bob } },
    data: { role: "admin" },
  });
  try {
    expect(await rename(artifact, f.bob, "Admin's")).toMatchObject({ title: "Admin's" });
  } finally {
    await f.db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: f.bob } },
      data: { role: "member" },
    });
  }
});

test("an empty, an over-long or an unchanged title changes nothing", async () => {
  const artifact = await f.make("Steady");
  await expect(rename(artifact, f.alice, "   ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(rename(artifact, f.alice, "x".repeat(201))).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(await rename(artifact, f.alice, "Steady")).toMatchObject({ changed: false });
  expect((await stored(artifact)).title).toBe("Steady");
});

test("someone who cannot read the artifact cannot rename it", async () => {
  const artifact = await f.make("Private", undefined, { target: `#${f.privateChannel}` });
  await expect(rename(artifact, f.bob, "Mine now")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await stored(artifact)).title).toBe("Private");
});

test("an Agent that follows is told, and one that does not follow is not", async () => {
  const artifact = await f.make("Tell them");
  await f.post(f.agents.reader, { operation: "follow", artifact });
  await f.post(f.agents.other, { operation: "unfollow", artifact });
  await rename(artifact, f.alice, "Told");
  const notices = (agentId: string) =>
    f.noticesOf(agentId).then((all) => all.filter((n) => n.externalEventId.startsWith(artifact)));
  const [notice] = await notices(f.agents.reader);
  expect(notice!.body).toContain("renamed");
  expect(notice!.body).toContain("Old title");
  expect(notice!.body).toContain("Tell them");
  expect(notice!.body).toContain("Told");
  expect(await notices(f.agents.other)).toHaveLength(0);
  f.noticeDelivery.down = true;
  try {
    expect(await rename(artifact, f.alice, "Still renamed")).toMatchObject({ changed: true });
  } finally {
    f.noticeDelivery.down = false;
  }
  expect((await stored(artifact)).title).toBe("Still renamed");
});

test("an Agent's later push keeps the new title and tells nobody it renamed", async () => {
  const artifact = await f.make("Before");
  await f.post(f.agents.reader, { operation: "follow", artifact });
  await rename(artifact, f.alice, "After");
  const before = (await f.noticesOf(f.agents.reader)).length;
  const pushed = await f.pushText(artifact, f.agents.writer, "changed\n");
  expect(pushed.status).toBe(200);
  const row = await stored(artifact);
  expect(row.title).toBe("After");
  expect(row.versions.map((v) => v.title)).toEqual(["After", "After"]);
  const after = (await f.noticesOf(f.agents.reader)).slice(before);
  expect(after.every((notice) => !notice.body.includes("Old title"))).toBe(true);
});

test("a push over an older base keeps the new title too", async () => {
  const artifact = await f.make("First");
  await f.pushText(artifact, f.agents.writer, "two\n");
  await rename(artifact, f.alice, "Renamed");
  const pushed = await f.post(f.agents.other, {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: f.key(),
    files: await f.manifestOf(f.agents.other, { "extra.md": "more\n" }),
  });
  expect(pushed.status).toBe(200);
  expect((await stored(artifact)).title).toBe("Renamed");
});
