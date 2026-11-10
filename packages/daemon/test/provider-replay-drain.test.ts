import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

test("a delivery still in flight in the dying session does not take the cold start's recovery with it", async () => {
  const h = await harness({ resume: "stored-1" });
  const open = h.gateNotices();
  try {
    // The notice of message 1 is not accepted yet, so the old input drain is busy with it.
    const telling = h.deliver(1).catch(() => {});
    await h.until(() => h.sessions[0]!.notices.some((notice) => notice.includes("#general")));
    h.failTurn(h.sessions[0]!);
    // The old session ends and rejects that notice; the cold start's recovery must wait for the
    // fresh session instead of running against the dying one.
    await h.until(() => h.sessions.length === 2);
    open();
    await h.until(() => h.sessions[1]!.notices.some((notice) => notice.includes("--unread")));
    await telling;

    // The message in flight stays unread in the attention, so the fresh session is told of it.
    expect(h.sessions[1]!.notices.join("\n")).toContain("#general 1 new message");
    expect(
      h.activities.filter((activity) => activity.detail?.includes("could not be started")),
    ).toEqual([]);
  } finally {
    open();
    await h.runtime.stop();
  }
});
