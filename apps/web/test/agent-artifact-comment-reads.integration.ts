import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

/**
 * Reading an artifact's comments (`comments`, and the summary a `read` carries): unseen comments
 * are the ones of others after the Agent's comment position, and only the unfiltered unseen read
 * moves it. The position is the Agent's own table, apart from its version position.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cr2");
});
afterAll(() => f.cleanup());

const comment = (agentId: string, artifact: string, body: string, extra: object = {}) =>
  f.post(agentId, { operation: "comment", artifact, body, idempotencyKey: f.key(), ...extra });
const comments = (agentId: string, artifact: string, extra: object = {}) =>
  f.post(agentId, { operation: "comments", artifact, ...extra });
/** Reads what others wrote, as an Agent must before it comments after them. */
const catchUp = (agentId: string, artifact: string) => comments(agentId, artifact);
const bodies = (answer: { body: Record<string, any> }) =>
  (answer.body.comments as { body?: string }[]).map((entry) => entry.body);

test("the unseen read lists what others wrote, oldest first, moves the position, and stays moved", async () => {
  const artifact = await f.make("Unseen");
  await comment(f.agents.reader, artifact, "Mine, never unseen.");
  await catchUp(f.agents.writer, artifact);
  await comment(f.agents.writer, artifact, "First from the writer.");
  await f.personComments(artifact, f.alice, { body: "Alice says hello.", path: "plan.md" });
  const first = await comments(f.agents.reader, artifact);
  expect(first.status).toBe(200);
  expect(first.body.view).toBe("unseen");
  expect(bodies(first)).toEqual(["First from the writer.", "Alice says hello."]);
  expect(first.body.comments[1].author).toEqual({ kind: "user", name: "Alice" });
  expect(first.body.nextCursor).toBeUndefined();
  // The Writer Bot's version 1 is one this Agent has not read.
  expect(first.body.unseenVersionCount).toBe(1);
  // Read: nothing is unseen any more, and a comment of its own is never unseen.
  expect(bodies(await comments(f.agents.reader, artifact))).toEqual([]);
  await comment(f.agents.reader, artifact, "Still mine.");
  expect(bodies(await comments(f.agents.reader, artifact))).toEqual([]);
  await f.personComments(artifact, f.alice, { body: "Third." });
  expect(bodies(await comments(f.agents.reader, artifact))).toEqual(["Third."]);
  // Another Agent has its own position: it still sees all of them but its own.
  expect(bodies(await comments(f.agents.other, artifact))).toEqual([
    "Mine, never unseen.",
    "First from the writer.",
    "Alice says hello.",
    "Still mine.",
    "Third.",
  ]);
});

test("all lists everything including its own, moves nothing, and never rewinds the position", async () => {
  const artifact = await f.make("All view");
  await comment(f.agents.reader, artifact, "One.");
  await catchUp(f.agents.writer, artifact);
  await comment(f.agents.writer, artifact, "Two.");
  const all = await comments(f.agents.reader, artifact, { all: true });
  expect(all.body.view).toBe("all");
  expect(bodies(all)).toEqual(["One.", "Two."]);
  const readers = { artifactId: artifact, agentId: f.agents.reader };
  expect(await f.db.artifactCommentPosition.count({ where: readers })).toBe(0);
  expect(bodies(await comments(f.agents.reader, artifact))).toEqual(["Two."]);
  const position = await f.db.artifactCommentPosition.findFirstOrThrow({ where: readers });
  await comments(f.agents.reader, artifact, { all: true });
  // An older cursor does not pull the position back: unseen is still empty.
  expect(
    bodies(
      await comments(f.agents.reader, artifact, { after: "1970-01-01T00:00:00.000Z|" + f.key() }),
    ),
  ).toEqual([]);
  expect(await f.db.artifactCommentPosition.findFirstOrThrow({ where: readers })).toMatchObject({
    seenAt: position.seenAt,
    seenId: position.seenId,
  });
  // The comment position is a table of its own: the version position is untouched.
  expect(await f.db.artifactReadPosition.count({ where: readers })).toBe(0);
});

test("comments page by 50 with a cursor; the position moves over the page returned only", async () => {
  const artifact = await f.make("Paging");
  for (let index = 1; index <= 55; index += 1)
    await f.personComments(artifact, f.alice, { body: `c${index}` });
  const first = await comments(f.agents.reader, artifact);
  expect(first.body.comments).toHaveLength(50);
  expect(first.body.nextCursor).toBeString();
  expect(first.body.comments[0].body).toBe("c1");
  expect(first.body.comments[49].body).toBe("c50");
  const second = await comments(f.agents.reader, artifact);
  expect(bodies(second)).toEqual(["c51", "c52", "c53", "c54", "c55"]);
  expect(second.body.nextCursor).toBeUndefined();
  // The all view pages by its cursor, without moving anything.
  const other = await comments(f.agents.other, artifact, { all: true });
  expect(other.body.comments).toHaveLength(50);
  const rest = await comments(f.agents.other, artifact, {
    all: true,
    after: other.body.nextCursor,
  });
  expect(bodies(rest)).toEqual(["c51", "c52", "c53", "c54", "c55"]);
  expect(
    await f.db.artifactCommentPosition.count({
      where: { artifactId: artifact, agentId: f.agents.other },
    }),
  ).toBe(0);
  // A cursor is refused as a 400, never a 500: not a date, not an id.
  for (const after of [
    "nonsense",
    `2026-13-45T25:61:61.000Z|${f.key()}`,
    `2026-01-01T00:00:00.000Z|${"-".repeat(36)}`,
    `2026-01-01T00:00:00.000Z|${"z".repeat(36)}`,
  ]) {
    const refused = await comments(f.agents.other, artifact, { after });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("(artifact-cursor)");
  }
  // An upper-case id is the same place.
  const upper = await comments(f.agents.other, artifact, {
    all: true,
    after: `${other.body.nextCursor.slice(0, 25)}${other.body.nextCursor.slice(25).toUpperCase()}`,
  });
  expect(bodies(upper)).toEqual(["c51", "c52", "c53", "c54", "c55"]);
});

test("a path filter lists one file's root comments and their replies, and moves nothing", async () => {
  const artifact = await f.make("By file", { "plan.md": "a\n", "data.csv": "x\n1\n" });
  const root = await comment(f.agents.writer, artifact, "On the plan.", { path: "plan.md" });
  await comment(f.agents.writer, artifact, "On the data.", { path: "data.csv" });
  await comment(f.agents.writer, artifact, "Overall.");
  await catchUp(f.agents.other, artifact);
  await comment(f.agents.other, artifact, "Reply on the plan.", { replyTo: root.body.id });
  await comment(f.agents.other, artifact, "Reply moved to the data.", {
    replyTo: root.body.id,
    path: "data.csv",
  });
  const plan = await comments(f.agents.reader, artifact, { path: "plan.md" });
  expect(bodies(plan)).toEqual(["On the plan.", "Reply on the plan.", "Reply moved to the data."]);
  expect(bodies(await comments(f.agents.reader, artifact, { path: "data.csv" }))).toEqual([
    "On the data.",
    "Reply moved to the data.",
  ]);
  // Reading one file marks nothing seen: the unfiltered read still returns all five.
  const readers = { artifactId: artifact, agentId: f.agents.reader };
  expect(await f.db.artifactCommentPosition.count({ where: readers })).toBe(0);
  expect((await comments(f.agents.reader, artifact)).body.comments).toHaveLength(5);
  expect(await f.db.artifactCommentPosition.count({ where: readers })).toBe(1);
});

test("a comment read before any version read does not make the artifact a read one", async () => {
  const artifact = await f.make("First read stays first");
  await comment(f.agents.writer, artifact, "Hello.");
  await comments(f.agents.reader, artifact);
  const read = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(read.body.unseen.firstRead).toBe(true);
  const again = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(again.body.unseen.firstRead).toBe(false);
});

test("the unseen version count says how many versions of others came since the Agent's position", async () => {
  const artifact = await f.make("Version count");
  await f.post(f.agents.reader, { operation: "read", artifact });
  await f.pushText(artifact, f.agents.writer, "two\n");
  await f.pushText(artifact, f.agents.writer, "three\n");
  expect((await comments(f.agents.reader, artifact)).body.unseenVersionCount).toBe(2);
});

test("read summarises the unseen comments beside the versions and does not move the comment position", async () => {
  const artifact = await f.make("Read summary");
  await f.post(f.agents.reader, { operation: "read", artifact });
  for (let index = 1; index <= 7; index += 1)
    await f.personComments(artifact, f.alice, {
      body: `${index}`.repeat(index === 7 ? 300 : 5),
      path: index % 2 ? "plan.md" : null,
    });
  const read = await f.post(f.agents.reader, { operation: "read", artifact });
  // A sibling of `unseen`, which stays about versions.
  expect(read.body.unseen).toEqual({ firstRead: false, versionCount: 0, versions: [] });
  expect(read.body.unseenComments.count).toBe(7);
  expect(read.body.unseenComments.comments).toHaveLength(5);
  // Newest first, an excerpt of at most 200 characters, with who, where and when.
  expect(read.body.unseenComments.comments[0]).toMatchObject({
    author: { kind: "user", name: "Alice" },
    path: "plan.md",
  });
  expect(read.body.unseenComments.comments[0].excerpt.length).toBeLessThanOrEqual(200);
  expect(read.body.unseenComments.comments[0].id).toBeString();
  expect(read.body.unseenComments.comments[0].createdAt).toBeString();
  expect(read.body.unseenComments.comments[1].excerpt).toBe("66666");
  // Reading again says the same; only `comments` moves the position.
  const unseenCount = async (extra: object = {}) =>
    (await f.post(f.agents.reader, { operation: "read", artifact, ...extra })).body.unseenComments
      .count;
  expect(await unseenCount()).toBe(7);
  expect(bodies(await comments(f.agents.reader, artifact))).toHaveLength(7);
  expect(await unseenCount()).toBe(0);
  // An older version's read carries no version summary, and still the comments.
  await catchUp(f.agents.writer, artifact);
  expect((await f.pushText(artifact, f.agents.writer, "two\n")).body.status).toBe("created");
  await f.personComments(artifact, f.alice, { body: "Eighth." });
  const older = await f.post(f.agents.reader, { operation: "read", artifact, version: 1 });
  expect(older.body.unseen).toBeNull();
  expect(older.body.unseenComments).toMatchObject({ count: 1 });
  expect(older.body.unseenComments.comments[0].excerpt).toBe("Eighth.");
  // A comment alone makes no version unseen, and the summary is exact at the page edge.
  expect(await unseenCount({ version: 2 })).toBe(1);
});
