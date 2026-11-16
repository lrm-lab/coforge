import { afterAll, beforeAll, expect, test } from "bun:test";
import { lockComments } from "#src/server/artifacts/artifact-comment-write.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { gateHelpers } from "./helpers/artifact-gate-helpers";

/**
 * The unseen gate: a push, a comment, a review or a resolve is refused (`artifact-unseen-changes`,
 * 409) while others commented, since the Agent's comment position, on what it is about to change or
 * answer, and (for a comment, a review, a resolve) while others pushed a version that changed its
 * file. What the refusal shows in full counts as seen, so the same request goes through unless some
 * comments were only excerpted (`unread`).
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cg");
});
afterAll(() => f.cleanup());

const { FILES, comment, read, shownIn, expectGate } = gateHelpers(() => f);

test("a push of a file is refused while others commented on that file since the position", async () => {
  const artifact = await f.make("Gate by file", FILES);
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan note.", path: "plan.md" });
  const refused = await f.pushText(artifact, f.agents.reader, "three\n");
  expectGate(refused, 1, [onPlan.id]);
  // Nothing was saved, and the same request goes through once the comments were read.
  expect((await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } })).currentVersion).toBe(
    1,
  );
  expect(shownIn(refused).comments.map((entry) => entry.body)).toEqual(["Plan note."]);
  expect(refused.body.details.unread).toBe(0);
  expect((await f.pushText(artifact, f.agents.reader, "three\n")).body.status).toBe("created");
});

test("a manifest push is gated by the files it changes or deletes, and by the whole artifact", async () => {
  const artifact = await f.make("Gate manifest", FILES);
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan note.", path: "plan.md" });
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
  expectGate(await f.pushFiles(artifact, f.agents.reader, {}, { delete: ["data.csv"] }), 1, [
    onData.id,
  ]);
  const whole = await f.personComments(artifact, f.alice, { body: "Overall." });
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n3\n" }), 1, [whole.id]);
  const settings = (agentId: string) =>
    f.post(agentId, {
      operation: "push",
      artifact,
      baseVersion: 2,
      idempotencyKey: f.key(),
      title: "Renamed",
      description: "A description",
    });
  const wholeAgain = await f.personComments(artifact, f.alice, { body: "Overall, again." });
  expectGate(await settings(f.agents.reader), 1, [wholeAgain.id]);
  expect((await settings(f.agents.reader)).body.status).toBe("created");
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

test("a read of the artifact marks the comments it shows in full as seen, a push marks none", async () => {
  const artifact = await f.make("Gate seen", FILES);
  await f.post(f.agents.reader, { operation: "read", artifact });
  const note = await f.personComments(artifact, f.alice, { body: "Look.", path: "plan.md" });
  expect((await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n2\n" })).status).toBe(200);
  const summary = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(summary.body.unseenComments.count).toBe(1);
  expect(summary.body.unseenComments.comments.map((entry: { id: string }) => entry.id)).toEqual([
    note.id,
  ]);
  expect(summary.body.unseenComments.unread).toBe(0);
  expect((await f.pushText(artifact, f.agents.reader, "a\n")).body.status).toBe("created");
  const again = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(again.body.unseenComments.count).toBe(0);
});

test("a read shows only a few comments in full; the rest stay unseen and hold a push until listed", async () => {
  const artifact = await f.make("Gate unread", FILES);
  const written = [];
  for (let index = 0; index < 12; index += 1)
    written.push(await f.personComments(artifact, f.alice, { body: `n${index}`, path: "plan.md" }));
  const summary = await f.post(f.agents.reader, { operation: "read", artifact });
  const block = summary.body.unseenComments;
  expect(block.count).toBe(12);
  expect(block.comments.map((entry: { id: string }) => entry.id)).toEqual(
    written.slice(0, 5).map((row) => row.id),
  );
  expect(block.excerpts.map((entry: { id: string }) => entry.id)).toEqual(
    written.slice(5, 10).map((row) => row.id),
  );
  expect(block.unread).toBe(7);
  const refused = await f.pushText(artifact, f.agents.reader, "z\n");
  expectGate(
    refused,
    7,
    written.slice(5, 12).map((row) => row.id),
  );
  expect(refused.body.details.unread).toBe(2);
  const second = await f.pushText(artifact, f.agents.reader, "z\n");
  expect(second.status).toBe(409);
  expect(second.body.details.unread).toBe(0);
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");

  const more = await f.make("Gate unread listed", FILES);
  for (let index = 0; index < 8; index += 1)
    await f.personComments(more, f.alice, { body: `m${index}`, path: "plan.md" });
  const held = await f.pushText(more, f.agents.reader, "z\n");
  expect(held.body.details.unread).toBe(3);
  expect((await read(f.agents.reader, more)).body.comments).toHaveLength(3);
  expect((await f.pushText(more, f.agents.reader, "z\n")).body.status).toBe("created");
});

test("a read of an older version moves nothing and shows no unseen block", async () => {
  const artifact = await f.make("Gate older", FILES);
  await f.pushFiles(artifact, f.agents.writer, { "data.csv": "x\n2\n" });
  await f.personComments(artifact, f.alice, { body: "Look.", path: "plan.md" });
  const older = await f.post(f.agents.reader, { operation: "read", artifact, version: 1 });
  expect(older.body.unseen).toBeNull();
  expect(older.body.unseenComments).toBeNull();
  const current = await f.post(f.agents.reader, { operation: "read", artifact });
  expect(current.body.unseenComments.count).toBe(1);
  expect(current.body.unseen.versionCount).toBe(1);
});

test("a filtered read does not clear the gate; the unfiltered one does", async () => {
  const artifact = await f.make("Gate filtered", FILES);
  const onData = await f.personComments(artifact, f.alice, { body: "Data.", path: "data.csv" });
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan.", path: "plan.md" });
  expect((await read(f.agents.reader, artifact, { path: "plan.md" })).body.comments).toHaveLength(
    1,
  );
  expectGate(await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\n9\n" }), 1, [
    onData.id,
  ]);
  expectGate(await f.pushText(artifact, f.agents.reader, "z\n"), 1, [onPlan.id]);
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");
});

test("the refusal counts them all, shows a few in full and excerpts the next few", async () => {
  const artifact = await f.make("Gate many", FILES);
  const written = [];
  for (let index = 0; index < 12; index += 1)
    written.push(await f.personComments(artifact, f.alice, { body: `n${index}` }));
  const refused = await f.pushText(artifact, f.agents.reader, "z\n");
  expect(refused.status).toBe(409);
  expect(refused.body.details.commentCount).toBe(12);
  expect(refused.body.details.unread).toBe(7);
  const shown = shownIn(refused);
  expect(shown.comments.map((entry) => entry.id)).toEqual(written.slice(0, 5).map((row) => row.id));
  expect(shown.excerpts.map((entry) => entry.id)).toEqual(
    written.slice(5, 10).map((row) => row.id),
  );
});

test("comments the refusal passes over are reported as skipped and counted as seen", async () => {
  const artifact = await f.make("Gate skipped", FILES);
  await f.personComments(artifact, f.alice, { body: "On data.", path: "data.csv" });
  const onPlan = await f.personComments(artifact, f.alice, { body: "On plan.", path: "plan.md" });
  const refused = await f.pushText(artifact, f.agents.reader, "z\n");
  expectGate(refused, 1, [onPlan.id]);
  expect(refused.body.details.skippedComments).toBe(1);
  const later = await read(f.agents.reader, artifact);
  expect(later.body.comments).toEqual([]);
});

test("a deleted comment does not hold a push up", async () => {
  const artifact = await f.make("Gate deleted", FILES);
  const gone = await f.personComments(artifact, f.alice, { body: "Withdrawn.", path: "plan.md" });
  await f.db.artifactComment.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
  expect((await f.pushText(artifact, f.agents.reader, "z\n")).body.status).toBe("created");
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
  const channel = await f.db.conversation.findFirstOrThrow({
    where: { workspaceId: f.workspaceId, channelName: f.privateChannel },
    select: { id: true },
  });
  await f.db.conversation.update({
    where: { id: channel.id },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    const answer = await f.pushText(hidden, f.agents.reader, "z\n");
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain("artifact-unseen-changes");
  } finally {
    await f.db.conversation.update({
      where: { id: channel.id },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
});

test("commenting needs the right to read: an Agent outside the private home comments once it is widened", async () => {
  const shared = await f.make("Tier", { "plan.md": "x\n" }, { target: `#${f.privateChannel}` });
  expect((await comment(f.agents.reader, shared, "Hello.", { path: "plan.md" })).status).toBe(404);
  expect((await f.pushText(shared, f.agents.reader, "z\n")).status).toBe(404);
  expect(
    (await f.post(f.agents.writer, { operation: "move", artifact: shared, to: "workspace" }))
      .status,
  ).toBe(200);
  expect((await comment(f.agents.reader, shared, "Hello.", { path: "plan.md" })).status).toBe(200);
  expect((await f.pushText(shared, f.agents.reader, "z\n")).status).toBe(200);
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
  const first = await read(f.agents.reader, artifact);
  expect(first.body.comments).toEqual([]);
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
