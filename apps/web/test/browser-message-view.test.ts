import { expect, test } from "bun:test";

import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";

import {
  mapBrowserMessage,
  type BrowserMessageRow,
} from "#src/server/conversations/conversation-history.server";
import { buildWeeklyReportAssistantRequestBody } from "#src/server/records/weekly-report-assistant-request.server";
import { buildPersonalKeyPointWakeText } from "#src/server/records/weekly-report-key-points.server";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";

test("Agent collection cards survive message history reads without exposing the JSON envelope", () => {
  const suggestion = {
    type: "collect-plan" as const,
    reportId: WORKSPACE_ID,
    year: 2026,
    week: 40,
  };
  const message = row({
    body: `请确认采集设置。\n[weekly-report-suggestion]\n${JSON.stringify(suggestion)}\n[/weekly-report-suggestion]`,
    sender: {
      userId: null,
      agentId: "assistant",
      user: null,
      agent: {
        name: "assistant",
        displayName: "Assistant",
        deletedAt: null,
        avatarObjectKey: null,
      },
    },
  });
  const view = mapBrowserMessage(message, WORKSPACE_ID);
  expect(view.weeklyReportSuggestion).toEqual(suggestion);
  // The Records side panel parses the original body from this shared projection too.
  expect(view.body).toBe(message.body);
  expect(view.weeklyReportDisplayBody).toBe("请确认采集设置。");
  expect(
    mapBrowserMessage({ ...message, sender: null }, WORKSPACE_ID).weeklyReportSuggestion,
  ).toBeUndefined();
});

test("a send-prompt envelope is a confirm card and the chat hides the fence", () => {
  const suggestion = {
    type: "send-prompt" as const,
    reportId: "11111111-1111-4111-8111-111111111111",
  };
  const message = row({
    body: [
      "请点下方确认发送。",
      "",
      "[weekly-report-suggestion]",
      JSON.stringify(suggestion),
      "[/weekly-report-suggestion]",
    ].join("\n"),
    sender: {
      userId: null,
      agentId: "assistant",
      user: null,
      agent: {
        name: "weekly-report",
        displayName: "周报助手",
        deletedAt: null,
        avatarObjectKey: null,
      },
    },
  });
  const view = mapBrowserMessage(message, WORKSPACE_ID);
  expect(view.weeklyReportSuggestion).toEqual(suggestion);
  expect(view.weeklyReportDisplayBody).toBe("请点下方确认发送。");
  expect(view.body).toBe(message.body);
});

test("a weekly-report context block stays on the message and leaves the chat text", () => {
  const body = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    userText: "帮我把摘要写短一点",
    contextManifest: { subjectType: "report", kind: "member" },
  });
  const view = mapBrowserMessage(
    row({
      body,
      sender: {
        userId: "user-1",
        agentId: null,
        user: {
          username: "lijian",
          displayName: "lijian",
          avatarObjectKey: null,
        },
        agent: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.body).toBe(body);
  expect(view.body).toContain("[weekly-report-context]");
  expect(view.weeklyReportDisplayBody).toBe("帮我把摘要写短一点");
  expect(view.weeklyReportHidden).toBeUndefined();
});

test("a weekly-report platform turn stays stored and is hidden from the chat", () => {
  const body = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    userText: buildPersonalKeyPointWakeText({
      reportId: "11111111-1111-4111-8111-111111111111",
      prompt: "请阅读该成员本周已提交的周报全文。",
      authorDisplayName: "lijian",
      year: 2026,
      week: 41,
    }),
    contextManifest: { subjectType: "report", kind: "member" },
    platformTurn: true,
  });
  const view = mapBrowserMessage(
    row({
      body,
      sender: {
        userId: "user-1",
        agentId: null,
        user: {
          username: "lijian",
          displayName: "lijian",
          avatarObjectKey: null,
        },
        agent: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.body).toContain("[weekly-report-context]");
  expect(view.body).toContain("[weekly-report-platform-turn]");
  expect(view.weeklyReportHidden).toBe(true);
});

test("an ordinary chat message is not treated as a weekly-report envelope", () => {
  const view = mapBrowserMessage(
    row({
      body: "今天的周报我自己来写。",
      sender: {
        userId: "user-1",
        agentId: null,
        user: {
          username: "lijian",
          displayName: "lijian",
          avatarObjectKey: null,
        },
        agent: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.weeklyReportDisplayBody).toBeUndefined();
  expect(view.weeklyReportHidden).toBeUndefined();
  expect(view.body).toBe("今天的周报我自己来写。");
});

function row(overrides: Partial<BrowserMessageRow>): BrowserMessageRow {
  return {
    id: "message-1",
    sequence: 1,
    threadRootId: null,
    senderMemberId: "member-1",
    body: "hello",
    createdAt: new Date("2026-09-17T10:00:00Z"),
    sender: null,
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides,
  };
}

test("an Agent-sent channel message carries senderAgentId", () => {
  const view = mapBrowserMessage(
    row({
      sender: {
        userId: null,
        agentId: "agent-builder",
        agent: { name: "builder", displayName: "Builder", deletedAt: null, avatarObjectKey: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderKind).toBe("agent");
  expect(view.senderAgentId).toBe("agent-builder");
});

test("a user-sent channel message has no senderAgentId", () => {
  const view = mapBrowserMessage(
    row({
      sender: {
        userId: "user-1",
        agentId: null,
        agent: null,
        user: {
          username: "ada",
          displayName: "Ada Lovelace",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderKind).toBe("user");
  expect(view.senderAgentId).toBeUndefined();
});

test("a channel mention exposes the current display label separately from its stable handle", () => {
  const view = mapBrowserMessage(
    row({
      mentions: [
        {
          kind: "user",
          actorId: "user-ada",
          handle: "ada",
          member: { user: { displayName: "Ada Lovelace" }, agent: null },
        },
      ],
    }),
    WORKSPACE_ID,
  );
  expect(view.mentions).toEqual([
    { kind: "user", actorId: "user-ada", handle: "ada", label: "Ada Lovelace" },
  ]);
});

test("a system message (no sender) has no senderAgentId", () => {
  const view = mapBrowserMessage(row({ sender: null }), WORKSPACE_ID);
  expect(view.senderKind).toBe("system");
  expect(view.senderAgentId).toBeUndefined();
});

// The browser shows a display name, like Slack; `@handle` stays what you type and what the
// Agent-facing projection sends. Before this, a person read as "@ada" beside an Agent reading
// as its display name, and the three browser projections each had their own rule.
test("a person's message is attributed to their display name, not their @username", () => {
  const view = mapBrowserMessage(
    row({
      sender: {
        userId: "user-1",
        agentId: null,
        agent: null,
        user: {
          username: "ada",
          displayName: "Ada Lovelace",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderName).toBe("Ada Lovelace");
});

test("a blank display name reads as the placeholder, never as the username", () => {
  const view = mapBrowserMessage(
    row({
      sender: {
        userId: "user-1",
        agentId: null,
        agent: null,
        user: {
          username: "ada",
          displayName: "   ",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderName).toBe(UNNAMED_PERSON_NAME);
});

test("an Agent's message is attributed to its display name, falling back to its handle", () => {
  const named = mapBrowserMessage(
    row({
      sender: {
        userId: null,
        agentId: "agent-builder",
        agent: { name: "builder", displayName: "Builder", deletedAt: null, avatarObjectKey: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(named.senderName).toBe("Builder");

  const unnamed = mapBrowserMessage(
    row({
      sender: {
        userId: null,
        agentId: "agent-builder",
        // `Agent.displayName` is a required column; unset is the empty string.
        agent: { name: "builder", displayName: "", deletedAt: null, avatarObjectKey: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(unnamed.senderName).toBe("builder");
});

test("a server-authored message stays attributed to System", () => {
  expect(mapBrowserMessage(row({ sender: null }), WORKSPACE_ID).senderName).toBe("System");
});

test("a person's message names its sender's user id, which opens their profile; an Agent's does not", () => {
  const person = mapBrowserMessage(
    row({
      sender: {
        userId: "33333333-3333-4333-8333-333333333333",
        agentId: null,
        user: { username: "grace", displayName: "Grace Hopper", avatarObjectKey: null },
        agent: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(person.senderUserId).toBe("33333333-3333-4333-8333-333333333333");
  const agent = mapBrowserMessage(
    row({
      sender: {
        userId: null,
        agentId: "assistant",
        user: null,
        agent: { name: "bot", displayName: "Bot", deletedAt: null, avatarObjectKey: null },
      },
    }),
    WORKSPACE_ID,
  );
  expect(agent.senderUserId).toBeUndefined();
});
