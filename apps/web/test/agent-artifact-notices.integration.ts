import { afterAll, beforeAll, expect, test } from "bun:test";
import { appEventConversation } from "#src/server/app-agent-events/app-event-target.server";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentsReadingArtifact } from "#src/server/artifacts/artifact-access.server";
import { ArtifactNotices } from "#src/server/artifacts/artifact-notices.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { noticeActions } from "./helpers/artifact-notice-actions";

/**
 * What an Agent is told of the artifacts it follows or is named in: who hears of a comment, a
 * review, a resolve and a version, why, and that the write stands when telling fails. Following
 * itself is `agent-artifact-follows.integration.ts`.
 */
let f: CommentsFixture;
const names = { writer: "", reader: "", other: "", alice: "" };
beforeAll(async () => {
  f = await commentsFixture("nt");
  for (const key of ["writer", "reader", "other"] as const)
    names[key] = (await f.db.agent.findUniqueOrThrow({ where: { id: f.agents[key] } })).name;
  names.alice = (await f.db.user.findUniqueOrThrow({ where: { id: f.alice } })).username;
});
afterAll(() => f.cleanup());

const { comment, catchUp, follow, unfollow, told } = noticeActions(() => f);

test("a comment tells the followers who did not write it, once, and not the others", async () => {
  const artifact = await f.make("Plan to discuss");
  await follow(f.agents.reader, artifact);
  const answer = await comment(f.agents.reader, artifact, "Why  three\nlines?", {
    path: "plan.md",
  });
  expect(answer.status).toBe(200);
  expect(answer.body.notified).toEqual([{ name: names.writer, reason: "subscribed" }]);
  expect(answer.body.notNotified).toEqual([]);
  expect(await told(f.agents.reader, artifact)).toHaveLength(0);
  expect(await told(f.agents.other, artifact)).toHaveLength(0);
  const [notice] = await told(f.agents.writer, artifact);
  expect(notice!.source).toBe("system.artifacts");
  expect(notice!.body).toContain("[CoForge notice]");
  expect(notice!.body).toContain("Plan to discuss");
  expect(notice!.body).toContain(artifact);
  expect(notice!.body).toContain("Why three lines?");
  expect(notice!.body).toContain("plan.md");
  expect(notice!.body).toContain(`coforge artifact comments ${artifact}`);
});

test("an excerpt is at most 200 characters, and a long comment stays in the artifact", async () => {
  const artifact = await f.make("Long comment");
  await comment(f.agents.reader, artifact, `start ${"word ".repeat(200)}end`);
  const [notice] = await told(f.agents.writer, artifact);
  const line = notice!.body.split("\n").find((entry) => entry.startsWith("- Text: "))!;
  expect([...JSON.parse(line.slice("- Text: ".length))].length).toBeLessThanOrEqual(200);
  expect(notice!.body).not.toContain("end");
});

test("a mention reaches an Agent that does not follow, outranks following, and names people apart", async () => {
  const artifact = await f.make("Mentions");
  await follow(f.agents.reader, artifact);
  await unfollow(f.agents.other, artifact);
  const answer = await comment(
    f.agents.reader,
    artifact,
    `Look, @${names.other} and @${names.writer}, also @${names.alice} and @nobody-here.`,
  );
  const reasons = Object.fromEntries(
    (answer.body.notified as { name: string; reason: string }[]).map((n) => [n.name, n.reason]),
  );
  expect(reasons).toEqual({ [names.other]: "mentioned", [names.writer]: "mentioned" });
  expect(answer.body.notNotified).toEqual([{ name: names.alice, reason: "not-agent" }]);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
  expect(await told(f.agents.other, artifact)).toHaveLength(1);
  expect((await told(f.agents.other, artifact))[0]!.body).toContain("You were mentioned");
});

test("an Agent that unfollowed hears of mentions only", async () => {
  const artifact = await f.make("Unfollowed hears mentions");
  await unfollow(f.agents.writer, artifact);
  const plain = await comment(f.agents.reader, artifact, "Nothing for you.");
  expect(plain.body.notified).toEqual([]);
  await catchUp(f.agents.writer, artifact);
  const named = await comment(f.agents.reader, artifact, `@${names.writer} please look`);
  expect(named.body.notified).toEqual([{ name: names.writer, reason: "mentioned" }]);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("a review tells each Agent once, a mention first", async () => {
  const artifact = await f.make("Reviewed");
  await follow(f.agents.other, artifact);
  const review = {
    operation: "review",
    artifact,
    body: `Summary for @${names.other}.`,
    comments: [
      { body: `One @${names.other}`, path: "plan.md" },
      { body: `Two @${names.other} and @${names.writer}` },
      { body: "Three" },
    ],
    idempotencyKey: f.key(),
  };
  const answer = await f.post(f.agents.reader, review);
  expect(answer.status).toBe(200);
  const reasons = Object.fromEntries(
    (answer.body.notified as { name: string; reason: string }[]).map((n) => [n.name, n.reason]),
  );
  expect(reasons).toEqual({ [names.other]: "mentioned", [names.writer]: "mentioned" });
  expect(await told(f.agents.other, artifact)).toHaveLength(1);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
  const [notice] = await told(f.agents.other, artifact);
  expect(notice!.body).toContain("3 comments on 1 file");

  const replay = await f.post(f.agents.reader, review);
  expect(replay.body.notified).toEqual(answer.body.notified);
  expect(await told(f.agents.other, artifact)).toHaveLength(1);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("a review with no mention tells followers once for the whole review", async () => {
  const artifact = await f.make("Plain review");
  const answer = await f.post(f.agents.reader, {
    operation: "review",
    artifact,
    comments: [{ body: "One" }, { body: "Two" }],
    idempotencyKey: f.key(),
  });
  expect(answer.body.notified).toEqual([{ name: names.writer, reason: "subscribed" }]);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("a resolve tells the thread's author, and followers only when it carries a note", async () => {
  const artifact = await f.make("Resolved");
  await follow(f.agents.other, artifact);
  const thread = await comment(f.agents.reader, artifact, "Please fix.");
  await catchUp(f.agents.writer, artifact);
  const silent = await f.post(f.agents.writer, {
    operation: "resolve",
    artifact,
    comment: thread.body.id,
  });
  expect(silent.status).toBe(200);
  expect(silent.body.notified).toEqual([{ name: names.reader, reason: "your_comment_resolved" }]);
  const again = await f.post(f.agents.writer, {
    operation: "resolve",
    artifact,
    comment: thread.body.id,
    note: "ignored",
  });
  expect(again.body.changed).toBe(false);
  expect(again.body.notified).toEqual([{ name: names.reader, reason: "your_comment_resolved" }]);
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);
  expect(await told(f.agents.other, artifact)).toHaveLength(1);

  await f.post(f.agents.writer, { operation: "reopen", artifact, comment: thread.body.id });
  const reopened = await f.post(f.agents.writer, {
    operation: "reopen",
    artifact,
    comment: thread.body.id,
  });
  expect(reopened.body.notified).toBeUndefined();
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);

  const noted = await f.post(f.agents.writer, {
    operation: "resolve",
    artifact,
    comment: thread.body.id,
    note: `Done, thanks @${names.writer}.`,
  });
  const reasons = Object.fromEntries(
    (noted.body.notified as { name: string; reason: string }[]).map((n) => [n.name, n.reason]),
  );
  expect(reasons).toEqual({ [names.reader]: "your_comment_resolved", [names.other]: "subscribed" });
  expect(await told(f.agents.reader, artifact)).toHaveLength(2);
  expect(await told(f.agents.other, artifact)).toHaveLength(2);
});

test("a note that names the thread's author tells it as a mention", async () => {
  const artifact = await f.make("Resolved with a mention");
  const thread = await comment(f.agents.reader, artifact, "Please fix.");
  await catchUp(f.agents.writer, artifact);
  const noted = await f.post(f.agents.writer, {
    operation: "resolve",
    artifact,
    comment: thread.body.id,
    note: `Fixed, @${names.reader}`,
  });
  expect(noted.body.notified).toEqual([{ name: names.reader, reason: "mentioned" }]);
});

test("a version tells the Agent that last changed a file it changes, if it follows", async () => {
  const artifact = await f.make("Files", { "plan.md": "plan\n", "data.csv": "x\n" });
  await follow(f.agents.reader, artifact);
  const first = await f.pushFiles(artifact, f.agents.reader, { "data.csv": "x\ny\n" });
  expect(first.body.status).toBe("created");
  expect(first.body.notified).toEqual([{ name: names.writer, reason: "your_file_changed" }]);
  expect((await told(f.agents.writer, artifact))[0]!.body).toContain("data.csv");

  const resent = await f.pushFiles(artifact, f.agents.other, {
    "plan.md": "plan\n",
    "data.csv": "x\ny\nz\n",
  });
  expect(resent.body.notified).toEqual([{ name: names.reader, reason: "your_file_changed" }]);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);

  await f.pushFiles(artifact, f.agents.reader, { "data.csv": "reader again\n" });
  await unfollow(f.agents.reader, artifact);
  const third = await f.pushFiles(artifact, f.agents.other, { "data.csv": "x\n" });
  expect(third.body.status).toBe("created");
  expect(third.body.notified).toEqual([]);
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);
});

test("a version that changes only what its writer last changed tells nobody", async () => {
  const artifact = await f.make("Own files");
  const pushed = await f.pushText(artifact, f.agents.writer, "mine\n");
  expect(pushed.body.notified).toEqual([]);
});

test("a title-only push renames without a version and tells the following Agents once, not the renamer; with files it notifies as a version", async () => {
  const artifact = await f.make("Old title");
  await follow(f.agents.reader, artifact);
  await follow(f.agents.other, artifact);
  const current = (await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } }))
    .currentVersion;
  const renamed = await f.post(f.agents.other, {
    operation: "push",
    artifact,
    baseVersion: current,
    idempotencyKey: f.key(),
    title: "New title",
  });
  expect(renamed.body.status).toBe("nothing");
  expect(renamed.body.titleChanged).toEqual({ from: "Old title" });
  expect((await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } })).currentVersion).toBe(
    current,
  );
  expect(renamed.body.notified).toEqual(
    expect.arrayContaining([
      { name: names.reader, reason: "subscribed" },
      { name: names.writer, reason: "subscribed" },
    ]),
  );
  expect(renamed.body.notified).toHaveLength(2);
  const [notice] = await told(f.agents.reader, artifact);
  expect(await told(f.agents.reader, artifact)).toHaveLength(1);
  expect(notice!.body).toContain(names.other);
  expect(notice!.body).toContain("Old title");
  expect(notice!.body).toContain("New title");
  expect(await told(f.agents.other, artifact)).toHaveLength(0);

  const both = await f.post(f.agents.other, {
    operation: "push",
    artifact,
    baseVersion: current,
    idempotencyKey: f.key(),
    title: "Newer title",
    files: await f.manifestOf(f.agents.other, { "plan.md": "changed\n" }),
  });
  expect(both.body.notified).toContainEqual({ name: names.writer, reason: "your_file_changed" });
});

test("an Agent that cannot read the artifact is not told and is named", async () => {
  const artifact = await f.make("Not for everyone");
  const row = await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } });
  const notices = new ArtifactNotices(
    f.db,
    f.notices,
    async (db, workspaceId, target, agentIds) =>
      new Set(
        [...(await agentsReadingArtifact(db, workspaceId, target, agentIds))].filter(
          (agentId) => agentId !== f.agents.other,
        ),
      ),
  );
  const report = await notices.comment({
    workspaceId: f.workspaceId,
    artifact: row,
    writerId: f.agents.reader,
    comment: { id: f.key(), path: null, version: 1, body: `@${names.other} @${names.writer}` },
  });
  expect(report.notified).toEqual([{ name: names.writer, reason: "mentioned" }]);
  expect(report.notNotified).toEqual([{ name: names.other, reason: "cannot-see" }]);
  expect(await told(f.agents.other, artifact)).toHaveLength(0);
});

test("a delivery that fails does not fail the write, and is reported", async () => {
  const artifact = await f.make("Delivery down");
  f.noticeDelivery.down = true;
  try {
    const answer = await comment(f.agents.reader, artifact, "Still stored.");
    expect(answer.status).toBe(200);
    expect(answer.body.notified).toEqual([]);
    expect(answer.body.notNotified).toEqual([{ name: names.writer, reason: "delivery-failed" }]);
    const stored = await f.post(f.agents.reader, { operation: "comments", artifact, all: true });
    expect(stored.body.comments.map((entry: { body: string }) => entry.body)).toEqual([
      "Still stored.",
    ]);
    expect(await told(f.agents.writer, artifact)).toHaveLength(0);
  } finally {
    f.noticeDelivery.down = false;
  }
});

test("a notice is stored once per write and Agent, however often it is sent", async () => {
  const artifact = await f.make("Sent twice");
  const row = await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } });
  const notice = {
    workspaceId: f.workspaceId,
    agentId: f.agents.writer,
    key: `${artifact}:same`,
    content: { headline: "Hello.", lines: [], next: "coforge artifact read x" },
  };
  await f.notices.deliver(notice);
  await f.notices.deliver(notice);
  expect(row.id).toBe(artifact);
  expect(await told(f.agents.writer, artifact)).toHaveLength(1);
});

test("an Agent reads its notices at @app.system.artifacts, and sends nothing there", async () => {
  const artifact = await f.make("Readable notices");
  await comment(f.agents.reader, artifact, "Hello");
  const conversation = await appEventConversation(
    f.db,
    f.workspaceId,
    f.agents.writer,
    "@app.system.artifacts",
  );
  const notice = await f.db.systemAgentEvent.findFirstOrThrow({
    where: { agentId: f.agents.writer, externalEventId: { startsWith: `${artifact}:` } },
  });
  expect(conversation).toEqual({ id: notice.conversationId });
  await expect(
    appEventConversation(f.db, f.workspaceId, f.key(), "@app.system.artifacts"),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    appEventConversation(f.db, f.workspaceId, f.agents.writer, "@app.system.artifacts", {
      send: true,
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("telling a write reads the home once, however many Agents follow", async () => {
  const counted: string[] = [];
  const countingDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL! }),
    log: [{ emit: "event", level: "query" }],
  });
  countingDb.$on("query", (event) => counted.push(event.query));
  try {
    const artifact = await f.make("Many followers");
    const row = await f.db.artifact.findUniqueOrThrow({ where: { id: artifact } });
    const tellOnce = async () => {
      counted.length = 0;
      await new ArtifactNotices(countingDb, f.notices).comment({
        workspaceId: f.workspaceId,
        artifact: row,
        writerId: f.agents.reader,
        comment: { id: f.key(), path: null, version: 1, body: "Anyone?" },
      });
      return [...counted];
    };
    const homeReads = (queries: string[]) =>
      queries.filter((query) => /FROM "public"\."conversations"/.test(query)).length;
    await follow(f.agents.other, artifact);
    const few = await tellOnce();
    const channel = await f.db.conversation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId, channelName: f.docsChannel },
    });
    for (let index = 0; index < 6; index += 1) {
      const agent = await f.db.agent.create({
        data: {
          workspaceId: f.workspaceId,
          name: `fan-${index}-${f.key().slice(0, 8)}`,
          displayName: `Fan ${index}`,
          ownerId: f.alice,
          runtimeConfig: {},
        },
      });
      await f.db.conversationMember.create({
        data: { conversationId: channel.id, workspaceId: f.workspaceId, agentId: agent.id },
      });
      await f.db.artifactFollow.create({
        data: { artifactId: artifact, agentId: agent.id, following: true },
      });
    }
    const many = await tellOnce();
    expect(homeReads(few)).toBe(1);
    expect(homeReads(many)).toBe(1);
    expect(many.length).toBe(few.length);
  } finally {
    await countingDb.$disconnect();
  }
});
