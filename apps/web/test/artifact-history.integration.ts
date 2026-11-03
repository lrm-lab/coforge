import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import type { ArtifactVersionPublishedEvent } from "#src/features/artifacts/artifact-realtime";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

/**
 * An artifact's history (task #385, step 4): its versions newest first, any one of them read
 * again, and going back to one, which saves its content as a new version and rewrites nothing.
 * Each new version is announced to the pages of its home, so an open document can say "X
 * published version N".
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let workspaceId: string;
let userId: string;
let outsiderId: string;
let channelId: string;
const published: { channel: string; event: ArtifactVersionPublishedEvent }[] = [];
let failSignal = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-history-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, {
    enabled: async () => true,
    signals: {
      async publish(channel, event) {
        if (failSignal) throw new Error("centrifugo down");
        published.push({ channel, event });
      },
    },
  });
  userId = (await db.user.create({ data: { username: `ah-${handle}`, displayName: "Ada" } })).id;
  outsiderId = (await db.user.create({ data: { username: `ah-o-${handle}`, displayName: "O" } }))
    .id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `ah-${handle}`,
        name: "History",
        members: {
          create: [
            { userId, role: "owner" },
            { userId: outsiderId, role: "member" },
          ],
        },
      },
    })
  ).id;
  channelId = (
    await db.conversation.create({
      data: { workspaceId, channelName: `ah-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({ data: { conversationId: channelId, workspaceId, userId } });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const upload = async (text: string) =>
  (await blobs.upload({ workspaceId, bytes: new TextEncoder().encode(text), actor: { userId } }))
    .sha256;

let made = 0;
async function document(home: "workspace" | "channel" = "workspace") {
  const artifact = await artifacts.create({
    workspaceId,
    home:
      home === "workspace"
        ? { kind: "workspace" }
        : { kind: "conversation", conversationId: channelId },
    name: `h-${(made += 1)}-${handle}`,
    kind: "markdown",
    entryPath: "document.md",
    author: { userId },
    title: "Plan",
  });
  return artifact.id;
}

const save = async (
  artifactId: string,
  baseVersion: number,
  text: string,
  extra: { note?: string; title?: string } = {},
) =>
  artifacts.push({
    workspaceId,
    artifactId,
    baseVersion,
    publisher: { userId },
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "document.md", sha256: await upload(text) }],
    ...extra,
  });

async function textAt(artifactId: string, version?: number) {
  const read = await artifacts.read({
    workspaceId,
    artifactId,
    reader: { userId },
    ...(version && { version }),
  });
  return new Response((await blobs.open(workspaceId, read.files[0]!.sha256))!.body).text();
}

test("the history lists versions newest first, a page at a time", async () => {
  const id = await document();
  await save(id, 0, "one\n", { note: "first" });
  await save(id, 1, "two\n");
  await save(id, 2, "three\n", { title: "Launch plan" });
  const page = await artifacts.history({
    workspaceId,
    artifactId: id,
    reader: { userId },
    limit: 2,
  });
  expect(page.versions.map((version) => version.number)).toEqual([3, 2]);
  expect(page.versions[0]).toMatchObject({
    number: 3,
    title: "Launch plan",
    publisher: { userId },
    revertedFrom: null,
  });
  expect(page.nextBefore).toBe(2);
  const rest = await artifacts.history({
    workspaceId,
    artifactId: id,
    reader: { userId },
    limit: 2,
    before: page.nextBefore!,
  });
  expect(rest.versions).toMatchObject([{ number: 1, note: "first" }]);
  expect(rest.nextBefore).toBeNull();
});

test("going back to a version saves its content and settings as a new one, history intact", async () => {
  const id = await document();
  await save(id, 0, "one\n");
  await save(id, 1, "two\n", { title: "Renamed" });
  const reverted = await artifacts.revert({
    workspaceId,
    artifactId: id,
    actor: { userId },
    to: 1,
    baseVersion: 2,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(reverted).toMatchObject({ status: "created", number: 3 });
  expect(await textAt(id)).toBe("one\n");
  expect(await textAt(id, 2)).toBe("two\n");
  const read = await artifacts.read({ workspaceId, artifactId: id, reader: { userId } });
  expect(read.artifact.title).toBe("Plan");
  const history = await artifacts.history({ workspaceId, artifactId: id, reader: { userId } });
  expect(history.versions[0]).toMatchObject({ number: 3, revertedFrom: 1 });
  // Going back to what is already there is nothing to save.
  expect(
    await artifacts.revert({
      workspaceId,
      artifactId: id,
      actor: { userId },
      to: 1,
      baseVersion: 3,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toEqual({ status: "nothing" });
});

test("going back over a version someone saved meanwhile is refused, and so is a missing one", async () => {
  const id = await document();
  await save(id, 0, "one\n");
  await save(id, 1, "two\n");
  const revert = (to: number, baseVersion: number) =>
    artifacts.revert({
      workspaceId,
      artifactId: id,
      actor: { userId },
      to,
      baseVersion,
      idempotencyKey: crypto.randomUUID(),
    });
  await expect(revert(1, 1)).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
  await expect(revert(9, 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("history and going back follow the home: unknown to a non-member of a private channel", async () => {
  const id = await document("channel");
  await save(id, 0, "one\n");
  await expect(
    artifacts.history({ workspaceId, artifactId: id, reader: { userId: outsiderId } }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    artifacts.revert({
      workspaceId,
      artifactId: id,
      actor: { userId: outsiderId },
      to: 1,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("each new version is announced to its home's pages; nothing is announced for no version", async () => {
  published.length = 0;
  const inChannel = await document("channel");
  await save(inChannel, 0, "one\n");
  const inWorkspace = await document();
  await save(inWorkspace, 0, "one\n");
  expect(published).toEqual([
    {
      channel: `chat:${channelId}`,
      event: {
        type: "artifact.version.published.v1",
        workspaceId,
        artifactId: inChannel,
        number: 1,
        publisher: { userId },
      },
    },
    {
      channel: `chat:workspace:${workspaceId}`,
      event: {
        type: "artifact.version.published.v1",
        workspaceId,
        artifactId: inWorkspace,
        number: 1,
        publisher: { userId },
      },
    },
  ]);
  published.length = 0;
  await save(inWorkspace, 1, "one\n");
  expect(published).toEqual([]);
  // A failed announcement fails no save: the version is there, and pages catch up on their read.
  failSignal = true;
  try {
    expect(await save(inWorkspace, 1, "two\n")).toMatchObject({ status: "created", number: 2 });
  } finally {
    failSignal = false;
  }
});

test("a reader who may not write reads the history but cannot go back", async () => {
  const id = await document();
  await save(id, 0, "one\n");
  await save(id, 1, "two\n");
  // The outsider is a Workspace member: a Workspace artifact is theirs to read and write, so
  // make it a public channel's, which they read without being in it.
  const open = (
    await db.conversation.create({
      data: { workspaceId, channelName: `ah-open-${handle}`, visibility: "public" },
    })
  ).id;
  await db.conversationMember.create({ data: { conversationId: open, workspaceId, userId } });
  await db.artifact.update({ where: { id }, data: { homeKey: `conversation:${open}` } });
  expect(
    (await artifacts.history({ workspaceId, artifactId: id, reader: { userId: outsiderId } }))
      .versions.length,
  ).toBe(2);
  await expect(
    artifacts.revert({
      workspaceId,
      artifactId: id,
      actor: { userId: outsiderId },
      to: 1,
      baseVersion: 2,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("a label on the content as it is is a version; the same files and no label are nothing", async () => {
  const id = await document();
  await save(id, 0, "one\n");
  expect(await save(id, 1, "one\n")).toEqual({ status: "nothing" });
  const labelled = await artifacts.push({
    workspaceId,
    artifactId: id,
    baseVersion: 1,
    publisher: { userId },
    idempotencyKey: crypto.randomUUID(),
    label: "release",
  });
  expect(labelled).toMatchObject({ status: "created", number: 2 });
});

test("history pages are whole numbers", async () => {
  const id = await document();
  await expect(
    artifacts.history({ workspaceId, artifactId: id, reader: { userId }, limit: Number.NaN }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-history-page" });
});
