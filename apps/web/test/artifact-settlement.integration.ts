import { afterAll, beforeAll, expect, test } from "bun:test";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { ArtifactGallery } from "#src/server/artifacts/artifact-gallery.server";
import { ArtifactSettlements } from "#src/server/artifacts/artifact-settlement.server";
import type { ArtifactSignalEvent } from "#src/server/artifacts/artifact-signals.server";
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

test("gallery cards, marks, and realtime settlement signals reflect settled and reopened transitions", async () => {
  const artifactId = await f.make("Gallery Settled Spec", undefined, {
    target: `#${f.docsChannel}`,
  });
  const published: Array<{ channel: string; event: ArtifactSignalEvent }> = [];
  const settlements = new ArtifactSettlements(f.db, {
    publish: async (channel, event) => {
      published.push({ channel, event });
    },
  });
  const gallery = new ArtifactGallery(f.db, f.artifacts.reads);

  const settleFirst = await settlements.settle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  expect(settleFirst.changed).toBe(true);
  await settlements.settle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  expect(published).toHaveLength(1);
  expect(published[0]?.event).toEqual({
    type: "artifact.settlement.changed.v1",
    workspaceId: f.workspaceId,
    artifactId,
  });

  const settledPage = await gallery.page({
    workspaceId: f.workspaceId,
    userId: f.bob,
    sort: "updated",
    limit: 20,
  });
  const settledCard = settledPage.artifacts.find((card) => card.id === artifactId);
  expect(settledCard?.settled).toMatchObject({ version: 1, by: { kind: "user" } });
  expect(settledCard?.reopened).toBeNull();

  const settledMarks = await gallery.marks({
    workspaceId: f.workspaceId,
    userId: f.bob,
    artifactIds: [artifactId],
  });
  expect(settledMarks[0]?.settled).toMatchObject({ version: 1, by: { kind: "user" } });
  expect(settledMarks[0]?.reopened).toBeNull();

  await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 1,
    note: "Hold first",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# v2\n" }),
  });
  await f.post(f.agents.writer, {
    operation: "push",
    idempotencyKey: f.key(),
    artifact: artifactId,
    baseVersion: 1,
    note: "Confirm reopen",
    files: await f.manifestOf(f.agents.writer, { "plan.md": "# v2\n" }),
  });

  const reopenedPage = await gallery.page({
    workspaceId: f.workspaceId,
    userId: f.bob,
    sort: "updated",
    limit: 20,
  });
  const reopenedCard = reopenedPage.artifacts.find((card) => card.id === artifactId);
  expect(reopenedCard?.settled).toBeNull();
  expect(reopenedCard?.reopened).toMatchObject({ version: 2, was: { version: 1 } });

  await settlements.settle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  const unsettled = await settlements.unsettle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  expect(unsettled.changed).toBe(true);
  await settlements.unsettle({
    workspaceId: f.workspaceId,
    artifactId,
    actor: { userId: f.alice },
  });
  expect(published).toHaveLength(3);
});
