import { afterAll, beforeAll, expect, test } from "bun:test";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;

beforeAll(async () => {
  f = await commentsFixture("stl");
});

afterAll(() => f.cleanup());

test("artifact settle and unsettle transition state, enforce push hold once, and record reopened metadata", async () => {
  const artifactId = await f.make("Architecture Spec", undefined, {
    target: `#${f.docsChannel}`,
  });

  const settleRes = await f.post(f.agents.reader, {
    operation: "settle",
    artifact: artifactId,
  });
  expect(settleRes.status).toBe(200);
  expect(settleRes.body.changed).toBe(true);
  expect(settleRes.body.newlyFollowing).toBe(true);
  expect(settleRes.body.artifact.settled).toMatchObject({
    version: 1,
    by: { kind: "agent" },
  });

  const repeatSettle = await f.post(f.agents.reader, {
    operation: "settle",
    artifact: artifactId,
  });
  expect(repeatSettle.status).toBe(200);
  expect(repeatSettle.body.changed).toBe(false);

  const readSettled = await f.post(f.agents.writer, {
    operation: "read",
    artifact: artifactId,
  });
  expect(readSettled.status).toBe(200);
  expect(readSettled.body.artifact.settled).toMatchObject({ version: 1 });
  expect(readSettled.body.artifact.reopened).toBeNull();

  const listed = await f.post(f.agents.writer, {
    operation: "list",
    target: `#${f.docsChannel}`,
  });
  expect(listed.status).toBe(200);
  const listedRows = (Array.isArray(listed.body) ? listed.body : listed.body.artifacts) as {
    id: string;
    settled: unknown;
  }[];
  const listedRow = listedRows.find((row) => row.id === artifactId);
  expect(listedRow?.settled).toMatchObject({ version: 1 });

  const renameWhileSettled = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 1,
    title: "Architecture Spec Final",
  });
  expect(renameWhileSettled.status).toBe(200);
  expect(renameWhileSettled.body.status).toBe("nothing");

  const heldPush = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 1,
    note: "Trying to edit settled spec",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# Spec v2\n" }),
  });
  expect(heldPush.status).toBe(409);
  expect(heldPush.body.error).toContain("artifact-settled");
  expect(heldPush.body.details).toMatchObject({
    title: "Architecture Spec Final",
    settledVersion: 1,
    nextVersion: 2,
  });

  const confirmedPush = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 1,
    note: "Confirmed update after hold",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# Spec v2\n" }),
  });
  expect(confirmedPush.status).toBe(200);
  expect(confirmedPush.body.number).toBe(2);

  const readReopened = await f.post(f.agents.reader, {
    operation: "read",
    artifact: artifactId,
  });
  expect(readReopened.status).toBe(200);
  expect(readReopened.body.artifact.settled).toBeNull();
  expect(readReopened.body.artifact.reopened).toMatchObject({
    version: 2,
    was: { version: 1 },
  });

  const humanSettle = await productionArtifacts(f.db).settlements.settle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  expect(humanSettle.changed).toBe(true);
  expect(humanSettle.artifact.settled).toMatchObject({
    version: 2,
    by: { kind: "user" },
  });

  const reheldAfterResettle = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 2,
    note: "Should hold again after re-settle",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# Spec v3 held\n" }),
  });
  expect(reheldAfterResettle.status).toBe(409);
  expect(reheldAfterResettle.body.details).toMatchObject({
    settledVersion: 2,
    nextVersion: 3,
  });

  const unsettleRes = await f.post(f.agents.reader, {
    operation: "unsettle",
    artifact: artifactId,
  });
  expect(unsettleRes.status).toBe(200);
  expect(unsettleRes.body.changed).toBe(true);
  expect(unsettleRes.body.artifact.settled).toBeNull();
  expect(unsettleRes.body.artifact.reopened).toBeNull();

  const repeatUnsettle = await f.post(f.agents.reader, {
    operation: "unsettle",
    artifact: artifactId,
  });
  expect(repeatUnsettle.status).toBe(200);
  expect(repeatUnsettle.body.changed).toBe(false);

  const pushAfterUnsettle = await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 2,
    note: "Push after manual unsettle goes straight through",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# Spec v3\n" }),
  });
  expect(pushAfterUnsettle.status).toBe(200);
  expect(pushAfterUnsettle.body.number).toBe(3);

  const privateDocId = await f.make("Private Only", undefined, {
    target: `#${f.privateChannel}`,
  });
  const unauthorizedSettle = await f.post(f.agents.reader, {
    operation: "settle",
    artifact: privateDocId,
  });
  expect(unauthorizedSettle.status).toBe(404);
});
