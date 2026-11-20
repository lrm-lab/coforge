import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import type { CommentsFixture } from "./helpers/artifact-comments-fixture";
import { personCommentsHarness } from "./helpers/person-comments-harness";

let f: CommentsFixture;
let comments: ArtifactPersonComments;
const h = personCommentsHarness("pca", (ready) => {
  f = ready.f;
  comments = ready.comments;
});
beforeAll(h.setUp);
afterAll(h.tearDown);
const { place, draft, post, noticesAbout, namesOf, pngOf } = h;

test("mentioning someone who cannot read the artifact is refused; too many mentions too", async () => {
  const artifact = await f.make("Mentions", undefined, { target: `#${f.privateChannel}` });
  const bob = await f.db.user.findUniqueOrThrow({ where: { id: f.bob } });
  const other = await f.db.agent.findUniqueOrThrow({ where: { id: f.agents.other } });
  await expect(post(artifact, `Look @${bob.username}`)).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-mention-cannot-see",
  });
  await expect(post(artifact, `Look @${other.name}`)).rejects.toMatchObject({
    errorId: "artifact-mention-cannot-see",
  });
  const writer = await f.db.agent.findUniqueOrThrow({ where: { id: f.agents.writer } });
  expect((await post(artifact, `Fine @${writer.name}`)).id).toBeString();
  const check = await comments.willNotify({
    ...place(artifact),
    body: `@${bob.username} @${other.name}`,
  });
  expect(check.cannotSee.sort()).toEqual([bob.username, other.name].sort());
  const open = await f.make("Open mentions");
  const handle = crypto.randomUUID().slice(0, 8);
  const names = Array.from({ length: 11 }, (_, index) => `many-${index}-${handle}`);
  await f.db.agent.createMany({
    data: names.map((name) => ({
      workspaceId: f.workspaceId,
      name,
      displayName: name,
      ownerId: f.alice,
      runtimeConfig: {},
    })),
  });
  try {
    const body = names.map((name) => `@${name}`).join(" ");
    expect((await comments.willNotify({ ...place(open), body })).tooMany).toBe(true);
    await expect(post(open, body)).rejects.toMatchObject({
      errorId: "artifact-too-many-mentions",
    });
    const ten = names
      .slice(0, 10)
      .map((name) => `@${name}`)
      .join(" ");
    expect((await comments.willNotify({ ...place(open), body: ten })).tooMany).toBe(false);
  } finally {
    await f.db.agent.deleteMany({ where: { name: { in: names } } });
  }
});

test("the people and Agents offered for @ are exactly those who can read the artifact", async () => {
  const open = await comments.candidates(place(await f.make("Open")));
  expect(open.viewerId).toBe(f.alice);
  expect(open.people.map((person) => person.name).sort()).toEqual(["Alice", "Bob"]);
  expect(open.agents.map((agent) => agent.name).sort()).toEqual([
    "Other Bot",
    "Reader Bot",
    "Writer Bot",
  ]);
  const closed = await comments.candidates(
    place(await f.make("Closed", undefined, { target: `#${f.privateChannel}` })),
  );
  expect(closed.people.map((person) => person.name)).toEqual(["Alice"]);
  expect(closed.agents.map((agent) => agent.name)).toEqual(["Writer Bot"]);
});

test("the will-notify preview names exactly the Agents the comment then tells", async () => {
  const artifact = await f.make("Notify");
  await f.post(f.agents.reader, { operation: "follow", artifact });
  await f.post(f.agents.other, { operation: "unfollow", artifact });
  const other = await f.db.agent.findUniqueOrThrow({ where: { id: f.agents.other } });
  const bob = await f.db.user.findUniqueOrThrow({ where: { id: f.bob } });
  const body = `Thoughts @${other.name} and @${bob.username}?`;
  const preview = await comments.willNotify({ ...place(artifact), body });
  expect(preview.notified.sort()).toEqual(["Other Bot", "Reader Bot", "Writer Bot"]);
  const posted = await post(artifact, body);
  expect(posted.notified.map((told) => told.name).sort()).toEqual(
    [other.name, ...(await namesOf(f.agents.reader, f.agents.writer))].sort(),
  );
  expect(posted.notNotified).toEqual([{ name: bob.username, reason: "not-agent" }]);
  for (const agentId of [f.agents.reader, f.agents.other, f.agents.writer])
    expect(await noticesAbout(agentId, artifact)).toHaveLength(1);
  const quiet = await comments.willNotify({ ...place(artifact), body: "Nothing special." });
  expect(quiet.notified.sort()).toEqual(["Reader Bot", "Writer Bot"]);
});

test("people's posts, uploads and previews are rate limited like Agent writes", async () => {
  const limited = new ArtifactPersonComments(f.db, f.blobs, f.notices, undefined, {
    admit: async () => ({ allowed: false, retryAfterSeconds: 7 }),
  });
  const artifact = await f.make("Rate limited");
  const refused = { errorId: "artifact-rate-limited", details: { retryAfterSeconds: 7 } };
  await expect(
    limited.post({ ...place(artifact), comment: draft("Too fast.") }),
  ).rejects.toMatchObject(refused);
  await expect(
    limited.uploadImage({ ...place(artifact), bytes: await pngOf(5) }),
  ).rejects.toMatchObject(refused);
  await expect(limited.willNotify({ ...place(artifact), body: "hi" })).rejects.toMatchObject(
    refused,
  );
  expect(await f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);
});

test("the preview refuses a body over the comment limit and resolves only a bounded number of handles", async () => {
  const closed = await f.make("Preview caps", undefined, { target: `#${f.privateChannel}` });
  await expect(
    comments.willNotify({ ...place(closed), body: "x".repeat(8001) }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const other = await f.db.agent.findUniqueOrThrow({ where: { id: f.agents.other } });
  const crowd = Array.from({ length: 50 }, (_, index) => `@nobody${index}`).join(" ");
  const preview = await comments.willNotify({ ...place(closed), body: `${crowd} @${other.name}` });
  expect(preview.cannotSee).toEqual([]);
});
