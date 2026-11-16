import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactVersionHistory } from "#src/server/artifacts/artifact-version-history.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let history: ArtifactVersionHistory;
beforeAll(async () => {
  f = await commentsFixture("vh");
  history = new ArtifactVersionHistory(f.db, f.artifacts.reads);
});
afterAll(() => f.cleanup());

test("lists versions newest first with publisher, note and changed files", async () => {
  const artifact = await f.make("History", { "plan.md": "one\n", "a.txt": "a\n" });
  await f.post(f.agents.other, {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: f.key(),
    note: "second pass",
    files: await f.manifestOf(f.agents.other, { "a.txt": "b\n" }),
  });
  const versions = await history.list({
    workspaceId: f.workspaceId,
    artifactId: artifact,
    userId: f.bob,
  });
  expect(versions.map((version) => version.number)).toEqual([2, 1]);
  expect(versions[0]).toMatchObject({
    note: "second pass",
    publisher: { kind: "agent", name: "Other Bot" },
    changedPaths: ["a.txt"],
    changedCount: 1,
    latest: true,
  });
  expect(versions[1]).toMatchObject({ publisher: { name: "Writer Bot" }, latest: false });
  expect(versions[1]!.changedPaths.sort()).toEqual(["a.txt", "plan.md"]);
});

test("an artifact the person cannot read has no history for them", async () => {
  const artifact = await f.make("Hidden", undefined, { target: `#${f.privateChannel}` });
  await expect(
    history.list({ workspaceId: f.workspaceId, artifactId: artifact, userId: f.bob }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
