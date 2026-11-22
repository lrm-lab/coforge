import { expect, test } from "bun:test";
import { mentionToken } from "@lrm/coforge-sdk/internal";
import {
  buildDueNoticeBody,
  memberMention,
  senderNoticeLabel,
} from "#src/server/tasks/task-due-worker.server";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CREATOR_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

test("due worker addresses people with stored mention tokens and humanLabel, never raw @username", () => {
  const humanOwner = {
    id: "member-1",
    userId: USER_ID,
    agentId: null,
    user: {
      username: "christopher_very_long_internal_username_that_must_never_leak",
      displayName: "Christopher Robin",
    },
    agent: null,
  };
  const humanCreator = {
    id: "member-2",
    userId: CREATOR_ID,
    agentId: null,
    user: {
      username: "aleksandra_wisniewska_kowalczyk_internal_login_handle",
      displayName: "Aleksandra Wiśniewska",
    },
    agent: null,
  };
  const agentMember = {
    id: "member-3",
    userId: null,
    agentId: AGENT_ID,
    user: null,
    agent: { name: "release-bot" },
  };

  expect(memberMention(humanOwner)).toBe(mentionToken("user", USER_ID));
  expect(memberMention(agentMember)).toBe(mentionToken("agent", AGENT_ID));

  expect(
    senderNoticeLabel({
      user: {
        username: "christopher_very_long_internal_username_that_must_never_leak",
        displayName: "Christopher Robin",
      },
      agent: null,
    }),
  ).toBe("Christopher Robin");
  expect(senderNoticeLabel({ user: null, agent: { name: "release-bot" } })).toBe("@release-bot");
  expect(senderNoticeLabel(null)).toBe("system");

  const body = buildDueNoticeBody({
    primaryMention: memberMention(humanOwner)!,
    ccMention: memberMention(humanCreator),
    occurrence: 2,
    title: "Ship Task Board",
    status: "in_progress",
    dueAt: new Date("2026-11-22T00:00:00.000Z"),
    dueHasTime: false,
    lastDiscussion: `${senderNoticeLabel({
      user: humanOwner.user,
      agent: null,
    })} (2026-11-21T12:00:00.000Z)`,
  });

  expect(body).toContain(mentionToken("user", USER_ID));
  expect(body).toContain(`(CC ${mentionToken("user", CREATOR_ID)})`);
  expect(body).toContain("Last discussion: Christopher Robin (2026-11-21T12:00:00.000Z)");
  expect(body).not.toContain("christopher_very_long_internal_username");
  expect(body).not.toContain("aleksandra_wisniewska_kowalczyk_internal");
});
