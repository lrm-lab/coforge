import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

const announcements = (notices: readonly string[]) =>
  notices.filter((notice) => notice.startsWith("Reminder due:"));
const appItem = {
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
  title: "Due",
  summary: "Now",
};

test("an App Inbox item announced only to the Session the provider rejected is announced to the fresh one", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    await h.runtime.mintAppItem("agent-a", appItem);
    expect(announcements(h.sessions[0]!.notices)).toHaveLength(1);

    h.failTurn(h.sessions[0]!);
    await h.until(() => h.sessions.length === 2);
    // The launch drains the inbox on its own; this drain settles with whatever it announced.
    await h.runtime.drainAppInboxNotices("agent-a");

    expect(announcements(h.sessions[1]!.notices)).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("an ordinary restart does not announce an item the Agent was already told of", async () => {
  const h = await harness({ resume: "stored-1" });
  try {
    await h.runtime.mintAppItem("agent-a", appItem);
    expect(announcements(h.sessions[0]!.notices)).toHaveLength(1);

    await h.stop();
    await h.start();
    await h.runtime.drainAppInboxNotices("agent-a");

    expect(h.sessions).toHaveLength(2);
    expect(announcements(h.sessions[1]!.notices)).toHaveLength(0);
  } finally {
    await h.runtime.stop();
  }
});
