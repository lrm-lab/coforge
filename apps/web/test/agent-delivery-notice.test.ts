import { expect, test } from "bun:test";

import { noticeViewIndex } from "#src/server/conversations/agent-delivery-notice.server";

// The tier rule needs to know two things only the server can say: the message's own notice kind,
// and whether its conversation is a Task's discussion. Both are read from the rows here, never
// from the target's spelling (raft, #coforge-backend:#14 seq 41), so a channel thread whose id
// happens to be digits stays channel traffic.

const delivery = (messageId: string, conversationId: string) => ({ messageId, conversationId });

test("a message's notice kind travels with its deliveries and nothing else", () => {
  const views = noticeViewIndex(
    [{ messageId: "m1", kind: "task.assigned_you" }],
    [],
    [delivery("m1", "c1"), delivery("m2", "c1")],
  );
  expect(views.get("m1")).toEqual({ noticeKind: "task.assigned_you" });
  expect(views.has("m2")).toBe(false);
});

test("a Task's discussion is marked from the Task's row, not from the target's shape", () => {
  const views = noticeViewIndex(
    [],
    [{ discussionConversationId: "c-discussion" }, { discussionConversationId: null }],
    // `#board:#12` reads like a task ref and is not one: only a Task naming the conversation is.
    [delivery("m1", "c-discussion"), delivery("m2", "c-thread")],
  );
  expect(views.get("m1")).toEqual({ taskDiscussion: true });
  expect(views.has("m2")).toBe(false);
});

test("an assignment notice inside a task's discussion says both, once", () => {
  const views = noticeViewIndex(
    [{ messageId: "m1", kind: "task.assigned_you" }],
    [{ discussionConversationId: "c-discussion" }],
    [delivery("m1", "c-discussion")],
  );
  expect(views.get("m1")).toEqual({ noticeKind: "task.assigned_you", taskDiscussion: true });
  expect(views.size).toBe(1);
});

test("an ordinary message in a channel says nothing, so the daemon judges it as before", () => {
  expect(noticeViewIndex([], [], [delivery("m1", "c1")]).size).toBe(0);
});
