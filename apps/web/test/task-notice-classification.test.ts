import { expect, test } from "bun:test";
import { AGENT_DM_LIMIT_NOTICE } from "#src/server/conversations/agent-dm-limits.server";
import { coordinatorChangeNotice } from "#src/server/conversations/channel-coordination.server";
import {
  NOTICE_PATTERNS,
  noticeActor,
  noticeKind,
  noticeText,
  quotedTask,
  assigneeMention,
} from "#src/server/tasks/task-notices.server";
import { unfollowNoticeBody } from "#src/server/tasks/task-unfollow-notice.server";

const quoted = quotedTask({ id: "task-1", number: 4, title: "Fix login" }, []);
const actor = noticeActor({ id: "member-1", user: { username: "ada", displayName: "Ada" } });
const assignee = assigneeMention({ user: { username: "bob" } });

const RENDERED: Array<[string, NonNullable<ReturnType<typeof noticeKind>>]> = [
  [noticeText.created([quoted]), "task.created"],
  [noticeText.converted(actor.displayName, quoted), "task.converted"],
  [noticeText.fromMessage(actor.displayName, quoted), "task.from_message"],
  [noticeText.assigned(actor.displayName, quoted, assignee), "task.assigned"],
  [noticeText.claimed(actor.handle, quoted), "task.claimed"],
  [noticeText.moved(actor.displayName, quoted, "in_progress"), "task.moved"],
  [noticeText.unassigned(actor.displayName, quoted), "task.unassigned"],
  ["@bob assigned you task #4: Fix login", "task.assigned_you"],
  [unfollowNoticeBody("Ada", "done"), "task.unfollowed"],
  [coordinatorChangeNotice("team", "Ada", "bot", undefined), "channel.coordinator_changed"],
  [coordinatorChangeNotice("team", "Ada", undefined, "bot"), "channel.coordinator_changed"],
  [AGENT_DM_LIMIT_NOTICE.AGENT_DM_CHAIN_LIMIT, "agent_dm.chain_limit"],
  [AGENT_DM_LIMIT_NOTICE.AGENT_DM_RATE_LIMIT, "agent_dm.rate_limit"],
  ['📌 Assigned @coforge-anvil to task #215 "Old"', "task.assigned"],
  ["[CoForge coordinator change] #team: coordinator=bot", "channel.coordinator_changed"],
];

test("every notice template renders text that classifies back to its kind", () => {
  for (const [body, kind] of RENDERED) expect(noticeKind(body), body).toBe(kind);
});

test("the backfill migration embeds every classification pattern", async () => {
  const migration = await Bun.file(
    new URL(
      "../prisma/migrations/20261102050000_system_messages_backfill/migration.sql",
      import.meta.url,
    ),
  ).text();
  for (const { pattern } of NOTICE_PATTERNS) expect(migration).toContain(pattern);
});
