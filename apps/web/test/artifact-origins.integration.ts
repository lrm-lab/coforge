import { afterAll, beforeAll, expect, test } from "bun:test";
import { messageAfterCommit } from "#src/server/conversations/message-after-commit.server";
import { ArtifactOrigins } from "#src/server/artifacts/artifact-origins.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let origins: ArtifactOrigins;
let docsId: string;
let privateId: string;

beforeAll(async () => {
  f = await commentsFixture("or");
  origins = new ArtifactOrigins(f.db);
  const conversation = (name: string) =>
    f.db.conversation
      .findFirstOrThrow({ where: { workspaceId: f.workspaceId, channelName: name } })
      .then((row) => row.id);
  docsId = await conversation(f.docsChannel);
  privateId = await conversation(f.privateChannel);
});
afterAll(() => f.cleanup());

const originOf = async (id: string) =>
  (await f.db.artifact.findUniqueOrThrow({ where: { id } })).originMessageId;
const link = (id: string) => `look at /w/some-workspace/artifacts/${id} please`;
const note = (input: { artifactId: string; conversationId: string; at?: Date; body?: string }) => {
  const messageId = crypto.randomUUID();
  return origins
    .noteMessage({
      workspaceId: f.workspaceId,
      conversationId: input.conversationId,
      messageId,
      body: input.body ?? link(input.artifactId),
      createdAt: input.at ?? new Date(Date.now() + 1000),
    })
    .then(() => messageId);
};

test("the first message in the artifact's own conversation that links it becomes its origin, and no later one replaces it", async () => {
  const id = await f.make("Origin plan");
  expect(await originOf(id)).toBeNull();
  const first = await note({ artifactId: id, conversationId: docsId });
  expect(await originOf(id)).toBe(first);
  await note({ artifactId: id, conversationId: docsId, at: new Date(Date.now() + 5000) });
  expect(await originOf(id)).toBe(first);
});

test("a message elsewhere, from before the artifact existed, or with no link names no origin", async () => {
  const id = await f.make("Other plan");
  await note({ artifactId: id, conversationId: privateId });
  await note({ artifactId: id, conversationId: docsId, at: new Date(0) });
  await note({ artifactId: id, conversationId: docsId, body: "nothing to see here" });
  expect(await originOf(id)).toBeNull();
});

test("a message with no artifact link does not touch the database at all", async () => {
  const idle = new ArtifactOrigins({
    $executeRaw: () => {
      throw new Error("queried");
    },
  } as never);
  await idle.noteMessage({
    workspaceId: f.workspaceId,
    conversationId: docsId,
    messageId: crypto.randomUUID(),
    body: "just chatting, see /w/some-workspace/tasks/7",
    createdAt: new Date(),
  });
});

test("a failing write is swallowed: the send it follows is never affected", async () => {
  const broken = new ArtifactOrigins({
    $executeRaw: () => Promise.reject(new Error("db down")),
  } as never);
  await broken.noteMessage({
    workspaceId: f.workspaceId,
    conversationId: docsId,
    messageId: crypto.randomUUID(),
    body: link(crypto.randomUUID()),
    createdAt: new Date(),
  });
});

test("a committed message that links the artifact names its origin through the send's own notifier, off the send's path", async () => {
  const id = await f.make("Notified plan");
  const message = await f.db.message.create({
    data: {
      workspaceId: f.workspaceId,
      conversationId: docsId,
      body: link(id),
      sequence: 900_000 + Math.floor(Math.random() * 90_000),
      createdAt: new Date(Date.now() + 1000),
    },
  });
  const notifier = messageAfterCommit(f.db, { notifyMessage: async () => {} });
  await notifier.notifyMessage(message.id);
  for (let i = 0; i < 50 && (await originOf(id)) === null; i++) await Bun.sleep(20);
  expect(await originOf(id)).toBe(message.id);
});

test("a read names the origin to someone who can read its conversation and only says one exists to anyone else", async () => {
  const id = await f.make("Seen plan", undefined, { target: `#${f.privateChannel}` });
  const read = (userId: string) =>
    f.artifacts.reads.read({ workspaceId: f.workspaceId, artifactId: id, reader: { userId } });
  await f.db.$executeRaw`UPDATE "artifacts" SET "access" = 'workspace' WHERE "id" = ${id}::uuid`;
  expect((await read(f.alice)).artifact.origin).toBeNull();
  const messageId = await note({ artifactId: id, conversationId: privateId });
  expect((await read(f.alice)).artifact.origin).toEqual({
    messageId,
    conversationId: privateId,
    homeKind: "channel",
  });
  expect((await read(f.bob)).artifact.origin).toEqual({ hidden: true });
});
