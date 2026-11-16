import { expect, test } from "bun:test";
import { runArtifact } from "../src/artifact-commands";
import { C1, ID, comment, invocation, transportAnswering } from "./artifact-comment-fixture";

/** `coforge artifact follow|unfollow` and what each write prints of following and of who was told. */

const artifact = { id: ID, name: "plan", title: "The plan", currentVersion: 3 };

test("follow and unfollow parse an artifact and send it", () => {
  expect(invocation(["follow", ID])).toEqual({
    command: "artifact",
    request: { operation: "follow", artifact: ID },
  });
  expect(invocation(["unfollow", ID, "--json"])).toEqual({
    command: "artifact",
    request: { operation: "unfollow", artifact: ID },
    json: true,
  });
  expect(() => invocation(["follow"])).toThrow();
});

test("follow and unfollow say the state, and how to change it", async () => {
  const following = transportAnswering({ artifact, following: true });
  const followed = (await runArtifact(invocation(["follow", ID]), following.transport)) as string;
  expect(following.sent).toEqual([{ operation: "follow", artifact: ID }]);
  expect(followed).toContain(`You follow "The plan" (${ID})`);
  expect(followed).toContain(`coforge artifact unfollow ${ID}`);

  const left = transportAnswering({ artifact, following: false });
  const unfollowed = (await runArtifact(invocation(["unfollow", ID]), left.transport)) as string;
  expect(unfollowed).toContain(`You do not follow "The plan" (${ID})`);
  expect(unfollowed).toContain("only mentions reach you");
  expect(unfollowed).toContain(`coforge artifact follow ${ID}`);

  const json = await runArtifact(invocation(["follow", ID, "--json"]), following.transport);
  expect(json).toEqual({ artifact, following: true });
});

test("a comment says that it now follows once, who was told and who was not", async () => {
  const { transport } = transportAnswering({
    ...comment(C1),
    newlyFollowing: true,
    notified: [
      { name: "writer", reason: "mentioned" },
      { name: "reader", reason: "subscribed" },
      { name: "fixer", reason: "your_file_changed" },
      { name: "asker", reason: "your_comment_resolved" },
    ],
    notNotified: [
      { name: "alice", reason: "not-agent" },
      { name: "ghost", reason: "cannot-see" },
      { name: "slow", reason: "delivery-failed" },
    ],
  });
  const said = (await runArtifact(
    invocation(["comment", ID]),
    transport,
    async () => "Hi",
  )) as string;
  expect(said.split("\n")).toEqual([
    `Posted c_${C1} on plan.md:3-4 (version 2).`,
    `You now follow this artifact: others' comments, and their changes to files you last changed, reach you. To stop: coforge artifact unfollow ${ID}`,
    "Told: @writer (mentioned), @reader (following), @fixer (file changed), @asker (comment resolved). They know; no need to announce it in a conversation.",
    "Not told: @alice (a person, not told), @ghost (cannot read the artifact), @slow (delivery failed: tell them yourself).",
  ]);
});

test("a write that follows no one and tells no one prints nothing more", async () => {
  const { transport } = transportAnswering({ ...comment(C1), notified: [], notNotified: [] });
  const said = (await runArtifact(
    invocation(["comment", ID]),
    transport,
    async () => "Hi",
  )) as string;
  expect(said).toBe(`Posted c_${C1} on plan.md:3-4 (version 2).`);
});

test("a review and a resolve print who was told too", async () => {
  const told = { notified: [{ name: "writer", reason: "subscribed" }] };
  const review = transportAnswering({
    review: { id: "r1", author: { kind: "agent", name: "Me" }, version: 2, body: null },
    comments: [comment(C1)],
    ...told,
  });
  const reviewed = (await runArtifact(
    invocation(["review", ID]),
    review.transport,
    async () => '[{"body":"x"}]',
  )) as string;
  expect(reviewed).toContain("Told: @writer (following).");

  const resolve = transportAnswering({ comment: comment(C1), changed: true, ...told });
  const resolved = (await runArtifact(
    invocation(["resolve", ID, C1]),
    resolve.transport,
  )) as string;
  expect(resolved).toContain("Resolved the thread");
  expect(resolved).toContain("Told: @writer (following).");

  const unchanged = transportAnswering({ comment: comment(C1), changed: false, notified: [] });
  const again = (await runArtifact(invocation(["resolve", ID, C1]), unchanged.transport)) as string;
  expect(again).not.toContain("Told");
});
