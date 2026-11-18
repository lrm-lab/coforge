import { afterAll, beforeAll, expect, test } from "bun:test";
import { backfillArtifactOrigins } from "#src/server/conversations/artifact-origin-backfill.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let docsId: string;
let privateId: string;
let sequence = 800_000;

beforeAll(async () => {
  f = await commentsFixture("bf");
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
const say = (conversationId: string, body: string, offsetMs = 1000) =>
  f.db.message
    .create({
      data: {
        workspaceId: f.workspaceId,
        conversationId,
        body,
        sequence: (sequence += 1),
        createdAt: new Date(Date.now() + offsetMs),
      },
    })
    .then((row) => row.id);
const link = (id: string) => `see /w/some-workspace/artifacts/${id}`;
const run = (options: Parameters<typeof backfillArtifactOrigins>[1] = {}) =>
  backfillArtifactOrigins(f.db, { workspaceId: f.workspaceId, ...options });

test("an old artifact's origin is the earliest message in its own conversation that links it", async () => {
  const id = await f.make("Old plan");
  await say(docsId, "unrelated chatter");
  await say(privateId, link(id));
  const first = await say(docsId, link(id));
  await say(docsId, `again ${link(id)}`);
  await run();
  expect(await originOf(id)).toBe(first);
});

test("a dry run writes nothing and a second run changes nothing", async () => {
  const id = await f.make("Dry plan");
  const message = await say(docsId, link(id));
  const dry = await run({ dryRun: true });
  expect(dry.candidates).toBeGreaterThan(0);
  expect(await originOf(id)).toBeNull();
  const first = await run();
  expect(first.written).toBeGreaterThan(0);
  expect(await originOf(id)).toBe(message);
  expect((await run()).written).toBe(0);
});

test("scanning a few messages at a time reaches every one and can resume from a cursor", async () => {
  const ids = [
    await f.make("Window one"),
    await f.make("Window two"),
    await f.make("Window three"),
  ];
  const messages: string[] = [];
  for (const id of ids) {
    await say(docsId, "filler");
    messages.push(await say(docsId, link(id)));
  }
  const small = await run({ scanWindow: 2, batchSize: 1 });
  for (const [i, id] of ids.entries()) expect(await originOf(id)).toBe(messages[i]!);
  expect(small.cursor).toBeTruthy();
  const resumed = await run({ fromMessageId: small.cursor!, scanWindow: 2 });
  expect(resumed.scanned).toBe(0);
});

test("a message from before the artifact existed names no origin", async () => {
  const before = await say(docsId, "early", -60_000);
  const id = await f.make("Late plan");
  await f.db.message.update({ where: { id: before }, data: { body: link(id) } });
  await run();
  expect(await originOf(id)).toBeNull();
});
