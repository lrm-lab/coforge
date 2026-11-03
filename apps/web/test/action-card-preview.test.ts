import { afterEach, describe, expect, test } from "bun:test";

import { actionCardPreviewText } from "#src/features/conversations/action-card-preview";
import { decodeConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { previewText } from "#src/features/conversations/preview-line";
import { overwriteGetLocale } from "#src/paraglide/runtime";
import { previewCardOf } from "#src/server/conversations/action-card-preview.server";

afterEach(() => overwriteGetLocale(() => "en"));

/** A stored card as a list read selects it. */
const stored = (kind: string, payload: Record<string, unknown>, draftHint: string | null = null) =>
  previewCardOf({ kind, payload: { type: kind, ...payload } as never, draftHint });

/** Each kind's stored payload, and its line in English (the stored body) and in Chinese. */
const CASES: [string, Record<string, unknown>, string, string][] = [
  [
    "channel:create",
    { name: "launch", visibility: "public", initialHumanIds: ["u-1"] },
    "Action card: create channel #launch",
    "操作卡片：创建群聊 #launch",
  ],
  [
    "agent:create",
    { name: "scout", description: "Finds things" },
    "Action card: create agent scout",
    "操作卡片：创建 Agent scout",
  ],
  [
    "channel:add_member",
    {
      channelId: "c-1",
      humanIds: ["u-1"],
      agentIds: ["a-1"],
      channelHandle: "launch",
      memberHandles: ["@frank", "@scout"],
    },
    "Action card: add @frank, @scout to #launch",
    "操作卡片：把 @frank、@scout 加入 #launch",
  ],
  [
    "app:register",
    { key: "notes", name: "Notes", description: "" },
    "Action card: register app Notes",
    "操作卡片：注册应用 Notes",
  ],
  [
    "app:recover_owner",
    { clientKey: "notes", appName: "Notes", toAgentId: "a-1", toAgentName: "scout" },
    "Action card: make scout the owner Agent of app notes",
    "操作卡片：将 scout 设为应用 notes 的负责 Agent",
  ],
  [
    "app:grant_agent",
    { requestId: "r-1", agentId: "a-1", appKey: "notes", appName: "Notes", scopes: [] },
    "Action card: approve my use of the app Notes (notes)",
    "操作卡片：批准我使用应用 Notes（notes）",
  ],
  [
    "page:fill",
    {
      prompt: "Sign in to the dashboard",
      agentId: "a-1",
      computerId: "k-1",
      fields: [
        { id: "f-1", label: "Email", input: "text" },
        { id: "f-2", label: "Password", input: "password" },
      ],
    },
    "Fill the page: Sign in to the dashboard (Email, Password)",
    "填入网页：Sign in to the dashboard（Email、Password）",
  ],
  [
    "page:fill",
    { agentId: "a-1", computerId: "k-1", fields: [{ id: "f-1", label: "Code", input: "text" }] },
    "Fill the page: Code",
    "填入网页：Code",
  ],
  [
    "desktop:takeover",
    { prompt: "Approve the login", agentId: "a-1", computerId: "k-1", agentName: "scout" },
    "Open the cloud desktop: Approve the login",
    "打开云电脑：Approve the login",
  ],
  [
    "desktop:takeover",
    { agentId: "a-1", computerId: "k-1", agentName: "scout" },
    "Open the cloud desktop to finish this step",
    "打开云电脑，完成这一步",
  ],
];

describe("an action card's preview line", () => {
  test.each(CASES)(
    "%s reads as its stored body in English and in Chinese",
    (kind, payload, en, zh) => {
      const card = stored(kind, payload)!;
      expect(actionCardPreviewText(card, "en")).toBe(en);
      expect(actionCardPreviewText(card, "zh-CN")).toBe(zh);
    },
  );

  test("collects only the values the line names, not the payload", () => {
    expect(stored("channel:create", CASES[0]![1])).toEqual({
      kind: "channel:create",
      params: { name: "launch" },
    });
  });

  test("the Agent's note follows on the next line, as the stored body has it", () => {
    const card = stored("agent:create", { name: "scout" }, "For the launch")!;
    expect(actionCardPreviewText(card, "zh-CN")).toBe("操作卡片：创建 Agent scout\nFor the launch");
    // A list shows a line or two of it, so a long note is cut well past that.
    expect(stored("agent:create", { name: "scout" }, "x".repeat(2000))!.hint).toHaveLength(480);
  });

  test("a card with nothing to write in the viewer's language keeps its stored body", () => {
    // A choice card's body is already the question in the asker's own words.
    expect(stored("choice", { prompt: "Ship?", options: [], to: "u-1" })).toBeUndefined();
    // An add_member card sent before its handles were kept.
    expect(stored("channel:add_member", { channelId: "c-1", humanIds: ["u-1"] })).toBeUndefined();
    expect(stored("app:future", { name: "x" })).toBeUndefined();
    expect(previewCardOf(null)).toBeUndefined();
    // A card the browser holds but cannot write (a kind from a newer server).
    expect(actionCardPreviewText({ kind: "app:future", params: {} }, "en")).toBeNull();
  });

  test("a list's preview writes the card in the viewer's language, cut to one line", () => {
    overwriteGetLocale(() => "zh-CN");
    const card = stored("channel:create", { name: "launch" }, "Line one\nline two")!;
    expect(previewText("Action card: create channel #launch", null, card)).toBe(
      "操作卡片：创建群聊 #launch Line one line two",
    );
    expect(previewText("Action card: create channel #launch", null, null)).toBe(
      "Action card: create channel #launch",
    );
  });
});

test("a live activity event keeps a well-formed card and refuses a malformed one", () => {
  const event = {
    type: "conversation.activity.v1",
    workspaceId: "w-1",
    conversationId: "c-1",
    messageId: "m-1",
    sequence: 3,
    kind: "channel",
    createdAt: "2026-11-03T00:00:00.000Z",
    preview: "Action card: create channel #launch",
    sender: { kind: "agent", name: "Scout" },
  };
  const card = { kind: "channel:create", params: { name: "launch" } };
  expect(decodeConversationActivityEvent({ ...event, card })?.card).toEqual(card);
  expect(decodeConversationActivityEvent(event)).not.toHaveProperty("card");
  expect(decodeConversationActivityEvent({ ...event, card: { kind: "" } })).toBeUndefined();
  expect(
    decodeConversationActivityEvent({ ...event, card: { kind: "x", params: [] } }),
  ).toBeUndefined();
});
