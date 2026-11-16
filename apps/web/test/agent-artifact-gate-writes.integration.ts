import { afterAll, beforeAll, expect, test } from "bun:test";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { gateHelpers } from "./helpers/artifact-gate-helpers";

/**
 * The unseen gate on a comment and a review: held up by unseen comments on the same file, thread
 * or (for a whole-artifact comment) any file, and by versions others pushed that changed the file;
 * a resolve is held up the same way. A review is held as a whole and names the first comment that
 * clashes.
 */
let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("cgw");
});
afterAll(() => f.cleanup());

const { FILES, comment, read, shownIn, expectGate } = gateHelpers(() => f);

test("a comment is held up by unseen comments on its file, its thread or any file for a whole-artifact comment", async () => {
  const artifact = await f.make("Gate comment", FILES);
  const root = await comment(f.agents.writer, artifact, "A thread on data.", { path: "data.csv" });
  await read(f.agents.reader, artifact);
  const onPlan = await f.personComments(artifact, f.alice, { body: "Plan.", path: "plan.md" });
  expect((await comment(f.agents.reader, artifact, "On data.", { path: "data.csv" })).status).toBe(
    200,
  );
  expectGate(await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" }), 1, [
    onPlan.id,
  ]);
  expect((await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" })).status).toBe(
    200,
  );
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
  const whole = await f.personComments(artifact, f.alice, { body: "Overall." });
  expectGate(await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" }), 1, [
    whole.id,
  ]);
  const onData = await f.personComments(artifact, f.alice, { body: "More.", path: "data.csv" });
  expectGate(await comment(f.agents.reader, artifact, "Overall, too."), 1, [onData.id]);
  expect((await comment(f.agents.reader, artifact, "Overall, too.")).status).toBe(200);
});

test("a comment, a review and a resolve are held up by a version others pushed that changed their file", async () => {
  const artifact = await f.make("Gate versions", FILES);
  const root = await comment(f.agents.writer, artifact, "Thread on plan.", { path: "plan.md" });
  await read(f.agents.reader, artifact);
  await f.pushFiles(artifact, f.agents.writer, { "data.csv": "x\n2\n" });
  expect((await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" })).status).toBe(
    200,
  );
  await read(f.agents.writer, artifact);
  await f.pushFiles(artifact, f.agents.writer, { "plan.md": "rewritten\n" });
  const held = await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" });
  expect(held.status).toBe(409);
  expect(held.body.details.commentCount).toBe(0);
  expect(held.body.details.versionCount).toBe(2);
  expect(shownIn(held).versions.map((entry) => entry.number)).toEqual([3, 2]);
  expect((await comment(f.agents.reader, artifact, "On plan.", { path: "plan.md" })).status).toBe(
    200,
  );
  await read(f.agents.writer, artifact);
  await f.pushFiles(artifact, f.agents.writer, { "plan.md": "again\n" });
  const resolve = () =>
    f.post(f.agents.writer, {
      operation: "resolve",
      artifact,
      comment: root.body.id,
    });
  const reviewKey = f.key();
  const review = () =>
    f.post(f.agents.reader, {
      operation: "review",
      artifact,
      comments: [{ body: "In review.", path: "plan.md" }],
      idempotencyKey: reviewKey,
    });
  expect((await review()).status).toBe(409);
  expect((await review()).status).toBe(200);
  await f.personComments(artifact, f.alice, { body: "Plan again.", path: "plan.md" });
  expect((await resolve()).status).toBe(409);
  expect((await resolve()).status).toBe(200);
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
