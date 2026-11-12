import { afterAll, beforeAll, expect, test } from "bun:test";
import { lockComments } from "#src/server/artifacts/artifact-comment-write.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

/**
 * The unseen-comments gate: a push, a comment or a review is refused (`artifact-unseen-comments`,
 * 409) while others commented, since the Agent's comment position, on what it is about to change
 * or answer. Reading the comments (`comments`, which moves the position) clears it.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cg");
});
afterAll(() => f.cleanup());

const FILES = { "plan.md": "one\ntwo\n", "data.csv": "x\n1\n" };
const comment = (agentId: string, artifact: string, body: string, extra: object = {}) =>
  f.post(agentId, { operation: "comment", artifact, body, idempotencyKey: f.key(), ...extra });
const read = (agentId: string, artifact: string, extra: object = {}) =>
  f.post(agentId, { operation: "comments", artifact, ...extra });

function expectGate(
  answer: { status: number; body: Record<string, any> },
  count: number,
  ids: string[],
) {
  expect(answer.status).toBe(409);
  expect(answer.body.error).toContain("(artifact-unseen-comments)");
  expect(answer.body.code).toBe("CONFLICT");
  expect(answer.body.details.count).toBe(count);
  expect((answer.body.details.commentIds as string).split(",")).toEqual(ids);
}

test("a push of a file is refused while others commented on that file since the position", async () => {
  const artifact = await f.make("Gate by file", FILES);
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan note.", path: "plan.md" });
  const refused = await f.pushText(artifact, f.agents.reader, "three\n");
  expectGate(refused, 1, [onPlan.id]);
  expect(refused.body.error).toContain("coforge artifact comments");
  // Nothing was saved, and the same request goes through once the comments were read.
  expect((await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } })).currentVersion).toBe(
    1,
  );
  await read(f.agents.reader, artifact);
  expect((await f.pushText(artifact, f.agents.reader, "three\n")).body.status).toBe("created");
});

test("a manifest push is gated by the files it changes or deletes, and by the whole artifact", async () => {
  const artifact = await f.make("Gate manifest", FILES);
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan note.", path: "plan.md" });
  // A push of another file is not in the way of a comment on plan.md.
  expect((await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n2\n" })).body.status).toBe(
    "created",
  );
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "plan.md": "changed\n" }), 1, [
    onPlan.id,
  ]);
  const onData = await f.personComments(artifact, f.alice, {
    body: "Data note.",
    path: "data.csv",
  });
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n3\n" }), 1, [
    onData.id,
  ]);
  // A file taken away counts as a file changed.
  expectGate(await f.pushFiles(artifact, f.agents.reader, {}, { delete: ["data.csv"] }), 1, [
    onData.id,
  ]);
  // A comment on the whole artifact is in the way of every push, settings included.
  const whole = await f.personComments(artifact, f.alice, { body: "Overall." });
  await read(f.agents.reader, artifact);
  const settings = (agentId: string) =>
    f.post(agentId, {
      operation: "push",
      artifact,
      baseVersion: 2,
      idempotencyKey: f.key(),
      title: "Renamed",
    });
  expect((await settings(f.agents.reader)).body.status).toBe("created");
  const wholeAgain = await f.personComments(artifact, f.alice, { body: "Overall, again." });
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n4\n" }), 1, [
    wholeAgain.id,
  ]);
  expectGate(await settings(f.agents.reader), 1, [wholeAgain.id]);
  expect(whole.id).not.toBe(wholeAgain.id);
});

test("a settings-only push is held up by whole-artifact comments alone", async () => {
  const artifact = await f.make("Gate settings", FILES);
  await f.personComments(artifact, f.alice, { body: "Plan note.", path: "plan.md" });
  const titled = await f.post(f.agents.reader, {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: f.key(),
    note: "retitled",
    title: "New title",
  });
  expect(titled.body.status).toBe("created");
});

test("an Agent's own comments, older ones and its own push never stand in its way", async () => {
  const artifact = await f.make("Gate own", FILES);
  await comment(f.agents.reader, artifact, "Mine.", { path: "plan.md" });
  expect((await f.pushText(artifact, f.agents.reader, "mine\n")).body.status).toBe("created");
  // The Writer Bot commented before the Reader Bot read: read, then push is free.
  await comment(f.agents.writer, artifact, "Theirs.", { path: "plan.md" });
  await read(f.agents.reader, artifact);
  expect((await f.pushText(artifact, f.agents.reader, "mine again\n")).body.status).toBe("created");
});

test("a push does not mark the comments of others as seen, and a read of the artifact does not either", async () => {
  const artifact = await f.make("Gate seen", FILES);
  await f.post(f.agents.reader, { operation: "read", artifact });
  const note = await f.personComments(artifact, f.alice, { body: "Look.", path: "plan.md" });
  expectGate(await f.pushText(artifact, f.agents.reader, "a\n"), 1, [note.id]);
  // Reading the artifact lists the comment and still leaves it unseen.
  const summary = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(summary.body.unseenComments.count).toBe(1);
  expectGate(await f.pushText(artifact, f.agents.reader, "a\n"), 1, [note.id]);
  // Its own push on another path moved its version position, not the comment one.
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "plan.md": "b\n" }), 1, [note.id]);
});

test("a filtered read does not clear the gate; the unfiltered one does", async () => {
  const artifact = await f.make("Gate filtered", FILES);
  const onData = await f.personComments(artifact, f.alice, { body: "Data.", path: "data.csv" });
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan.", path: "plan.md" });
  expect((await read(f.agents.reader, artifact, { path: "plan.md" })).body.comments).toHaveLength(
    1,
  );
  expectGate(await f.pushText(artifact, f.agents.reader, "z\n"), 1, [onPlan.id]);
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n9\n" }), 1, [
    onData.id,
  ]);
  await read(f.agents.reader, artifact);
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");
});

test("the refusal counts them all and lists the first ten", async () => {
  const artifact = await f.make("Gate many", FILES);
  const written = [];
  for (let index = 0; index < 12; index += 1)
    written.push(await f.personComments(artifact, f.alice, { body: `n${index}` }));
  expectGate(
    await f.pushText(artifact, f.agents.reader, "z\n"),
    12,
    written.slice(0, 10).map((row) => row.id),
  );
});

test("a deleted comment does not hold a push up", async () => {
  const artifact = await f.make("Gate deleted", FILES);
  const gone = await f.personComments(artifact, f.alice, { body: "Withdrawn.", path: "plan.md" });
  await f.db.artifactComment.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");
});

test("a comment is held up by unseen comments on its file, its thread or the whole artifact", async () => {
  const artifact = await f.make("Gate comment", FILES);
  const root = await comment(f.agents.writer, artifact, "A thread on data.", { path: "data.csv" });
  await read(f.agents.reader, artifact);
  // Another file: no clash. The same file: refused until read.
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan.", path: "plan.md" });
  expect((await comment(f.agents.reader, artifact, "On data.", { path: "data.csv" })).status).toBe(
    200,
  );
  expectGate(await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" }), 1, [
    onPlan.id,
  ]);
  await read(f.agents.reader, artifact);
  expect((await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" })).status).toBe(
    200,
  );
  // The same thread: refused, though the reply's own path is another file.
  const reply = await f.personComments(artifact, f.alice, {
    body: "In the thread.",
    path: "data.csv",
    replyToRoot: root.body.id,
  });
  expectGate(
    await comment(f.agents.reader, artifact, "Answer.", { replyTo: root.body.id, path: "plan.md" }),
    1,
    [reply.id],
  );
  await read(f.agents.reader, artifact);
  // The whole artifact: refused for a comment on a file and for one on the whole.
  const whole = await f.personComments(artifact, f.alice, { body: "Overall." });
  expectGate(await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" }), 1, [
    whole.id,
  ]);
  expectGate(await comment(f.agents.reader, artifact, "Overall, too."), 1, [whole.id]);
  await read(f.agents.reader, artifact);
  // A comment on the whole artifact is not held up by a note on one file.
  await f.personComments(artifact, f.alice, { body: "More on plan.", path: "plan.md" });
  expect((await comment(f.agents.reader, artifact, "Overall, too.")).status).toBe(200);
});

test("a review is held up as a whole and names the first comment that clashes", async () => {
  const artifact = await f.make("Gate review", FILES);
  const onData = await f.personComments(artifact, f.alice, { body: "Data.", path: "data.csv" });
  const answer = await f.post(f.agents.reader, {
    operation: "review",
    artifact,
    comments: [
      { body: "On plan.", path: "plan.md" },
      { body: "On data.", path: "data.csv" },
    ],
    idempotencyKey: f.key(),
  });
  expectGate(answer, 1, [onData.id]);
  expect(answer.body.details.index).toBe(1);
  expect(
    await f.db.artifactComment.count({
      where: { artifactId: artifact, authorAgentId: f.agents.reader },
    }),
  ).toBe(0);
  await read(f.agents.reader, artifact);
  const retry = await f.post(f.agents.reader, {
    operation: "review",
    artifact,
    comments: [
      { body: "On plan.", path: "plan.md" },
      { body: "On data.", path: "data.csv" },
    ],
    idempotencyKey: f.key(),
  });
  expect(retry.status).toBe(200);
});

test("a save or comment that already landed replays, though someone commented since", async () => {
  const artifact = await f.make("Gate replay", FILES);
  const commentBody = {
    operation: "comment",
    artifact,
    body: "Mine.",
    path: "plan.md",
    idempotencyKey: f.key(),
  };
  const first = await f.post(f.agents.reader, commentBody);
  const pushBody = {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: f.key(),
    files: await f.manifestOf(f.agents.reader, { "plan.md": "replayed\n" }),
  };
  expect((await f.post(f.agents.reader, pushBody)).body.status).toBe("created");
  await f.personComments(artifact, f.alice, { body: "Late news.", path: "plan.md" });
  const commentAgain = await f.post(f.agents.reader, commentBody);
  expect(commentAgain.status).toBe(200);
  expect(commentAgain.body.id).toBe(first.body.id);
  const pushAgain = await f.post(f.agents.reader, pushBody);
  expect(pushAgain.status).toBe(200);
  expect(pushAgain.body.status).toBe("replayed");
});

test("a request for an artifact the Agent cannot read is answered as missing, not as a gate", async () => {
  const hidden = await f.make(
    "Gate hidden",
    { "plan.md": "x\n" },
    { target: `#${f.privateChannel}` },
  );
  await f.personComments(hidden, f.alice, { body: "Private." });
  const answer = await f.pushText(hidden, f.agents.reader, "z\n");
  expect(answer.status).toBe(404);
  expect(JSON.stringify(answer.body)).not.toContain("artifact-unseen-comments");
});

test("commenting needs the right to read, not to write: the Workspace tier lets a reader comment", async () => {
  const shared = await f.make("Tier", { "plan.md": "x\n" }, { target: `#${f.privateChannel}` });
  // The Reader Bot is not in the private channel: missing until the artifact's tier widens.
  expect((await comment(f.agents.reader, shared, "Hello.")).status).toBe(404);
  await f.db.artifact.update({ where: { id: shared }, data: { access: "workspace" } });
  const widened = await comment(f.agents.reader, shared, "Hello.", { path: "plan.md" });
  expect(widened.status).toBe(200);
  // It still may not write there: the tier widens reading only.
  expect((await f.pushText(shared, f.agents.reader, "z\n")).status).toBe(403);
});

test("an unseen read from a cursor beyond the position does not mark what it skipped as read", async () => {
  const artifact = await f.make("Gate cursor", FILES);
  const written = [];
  for (const body of ["one", "two", "three"])
    written.push(await f.personComments(artifact, f.alice, { body }));
  const ahead = `${written[1]!.createdAt.toISOString()}|${written[1]!.id}`;
  const page = await read(f.agents.reader, artifact, { after: ahead });
  expect(page.body.comments.map((entry: { body: string }) => entry.body)).toEqual(["three"]);
  expectGate(
    await f.pushText(artifact, f.agents.reader, "z\n"),
    3,
    written.map((row) => row.id),
  );
  // A cursor at the position (what a page of the unfiltered read names) goes on as usual.
  const first = await read(f.agents.reader, artifact);
  expect(first.body.comments).toHaveLength(3);
  const behind = await read(f.agents.reader, artifact, { after: ahead });
  expect(behind.body.comments).toEqual([]);
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");
});

test("a push that only changes the entry file is gated by comments on the old and the new entry", async () => {
  const artifact = await f.make("Gate entry", { "plan.md": "one\n", "other.md": "two\n" });
  const onOther = await f.personComments(artifact, f.alice, { body: "Other.", path: "other.md" });
  const entryOnly = async (agentId: string, entry: string) =>
    f.post(agentId, {
      operation: "push",
      artifact,
      baseVersion: (await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } }))
        .currentVersion,
      idempotencyKey: f.key(),
      entry,
    });
  // The new entry has a comment the Agent has not read.
  expectGate(await entryOnly(f.agents.reader, "other.md"), 1, [onOther.id]);
  await read(f.agents.reader, artifact);
  expect((await entryOnly(f.agents.reader, "other.md")).body.status).toBe("created");
  // The entry it leaves has one too.
  const onOld = await f.personComments(artifact, f.alice, { body: "Old.", path: "other.md" });
  expectGate(await entryOnly(f.agents.reader, "plan.md"), 1, [onOld.id]);
});

test("the gate runs under the comment lock: a comment committed first is seen, one that waits for it is not missed", async () => {
  const artifact = await f.make("Gate lock", FILES);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  let landed = "";
  const writer = f.db.$transaction(async (tx) => {
    await lockComments(tx, artifact);
    locked();
    await held;
    landed = (
      await tx.artifactComment.create({
        data: {
          artifactId: artifact,
          version: 1,
          path: "plan.md",
          authorUserId: f.alice,
          body: "Landed under the lock.",
        },
      })
    ).id;
  });
  await isLocked;
  const push = f.pushText(artifact, f.agents.reader, "racing\n");
  await f.waitForLockWaiter();
  release();
  await writer;
  // Held back by the lock, the push looks after the comment committed and is refused.
  expectGate(await push, 1, [landed]);
  expect((await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } })).currentVersion).toBe(
    1,
  );
});
