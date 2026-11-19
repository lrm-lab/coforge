import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  linkPageLookup,
  memberArtifactWorkspaceSlug,
  publicPageLookup,
} from "#src/server/artifacts/artifact-public-page.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let lookup: ReturnType<typeof linkPageLookup>;

beforeAll(async () => {
  f = await commentsFixture("ll");
  lookup = linkPageLookup(f.db, async () => true);
});
afterAll(() => f.cleanup());

const share = (id: string) =>
  f.db.$executeRaw`UPDATE "artifacts" SET "access" = 'link' WHERE "id" = ${id}::uuid`;

test("a link-tier artifact is found and a conversation-tier one is not", async () => {
  const shared = await f.make("Shared page");
  const plain = await f.make("Plain page");
  await share(shared);
  expect(await lookup(shared)).toMatchObject({ shared: true, page: { artifactId: shared } });
  expect(await lookup(plain)).toEqual({ shared: false, page: null });
});

test("a deleted link-tier artifact is not found, the same as one that never existed", async () => {
  const id = await f.make("Soon gone");
  await share(id);
  await f.db.artifact.update({ where: { id }, data: { deletedAt: new Date() } });
  expect(await lookup(id)).toEqual({ shared: false, page: null });
  expect(await lookup(crypto.randomUUID())).toEqual({ shared: false, page: null });
});

test("a revoked public token finds nothing even when its artifact is link-tier again", async () => {
  const id = await f.make("Revoked page");
  await share(id);
  const token = `tok-${crypto.randomUUID()}`;
  await f.db.artifactPublicLink.create({
    data: { artifactId: id, token, createdByUserId: f.alice, revokedAt: new Date() },
  });
  expect(await publicPageLookup(f.db, async () => true)(token)).toBeNull();
  await f.db.artifactPublicLink.update({ where: { token }, data: { revokedAt: null } });
  expect(await publicPageLookup(f.db, async () => true)(token)).toMatchObject({
    access: "link",
    artifactId: id,
    version: expect.any(Number),
  });
});

test("an artifact with an active public link resolves via linkPageLookup until revoked", async () => {
  const id = await f.make("Link-shared doc");
  expect(await lookup(id)).toEqual({ shared: false, page: null });
  const token = `tok-${crypto.randomUUID()}`;
  await f.db.artifactPublicLink.create({
    data: { artifactId: id, token, createdByUserId: f.alice },
  });
  expect(await lookup(id)).toMatchObject({ shared: true, page: { artifactId: id } });
  await f.db.artifactPublicLink.update({ where: { token }, data: { revokedAt: new Date() } });
  expect(await lookup(id)).toEqual({ shared: false, page: null });
});

test("memberArtifactWorkspaceSlug returns the workspace slug only for active artifacts in a member's workspace", async () => {
  const id = await f.make("Member redirect target");
  const workspace = await f.db.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { slug: true },
  });
  const outsider = (
    await f.db.user.create({
      data: { username: `ll-out-${crypto.randomUUID().slice(0, 8)}`, displayName: "Outsider" },
    })
  ).id;

  try {
    expect(await memberArtifactWorkspaceSlug(f.db, id, f.alice)).toBe(workspace.slug);
    expect(await memberArtifactWorkspaceSlug(f.db, id, outsider)).toBeNull();
    expect(await memberArtifactWorkspaceSlug(f.db, crypto.randomUUID(), f.alice)).toBeNull();

    await f.db.artifact.update({ where: { id }, data: { deletedAt: new Date() } });
    expect(await memberArtifactWorkspaceSlug(f.db, id, f.alice)).toBeNull();
  } finally {
    await f.db.user.deleteMany({ where: { id: outsider } });
  }
});
