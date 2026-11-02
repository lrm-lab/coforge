import { afterEach, expect, test } from "bun:test";

import { overwriteGetLocale } from "#src/paraglide/runtime";

import { decodeConversationActivityEvent } from "./conversation-activity-event";
import { MESSAGE_PREVIEW_MAX_LENGTH, previewNoticeOf, previewText } from "./preview-line";

const claimed = {
  kind: "task.claimed",
  params: {
    claimer: { memberId: "m-1", handle: "frank-an", displayName: "Frank An" },
    task: { taskId: "t-4", number: 4, title: "Fix login" },
  },
};

afterEach(() => overwriteGetLocale(() => "en"));

test("a notice's preview reads in the viewer's language; any other preview as the server wrote it", () => {
  overwriteGetLocale(() => "zh-CN");
  expect(previewText('📌 frank-an claimed #4 "Fix login"', claimed)).toBe(
    "📌 Frank An 认领了任务 #4「Fix login」",
  );
  expect(previewText("hello there")).toBe("hello there");
  expect(previewText("kept", { kind: "task.renamed", params: {} })).toBe("kept");
});

test("a rendered notice is cut to one preview line like any other", () => {
  overwriteGetLocale(() => "en");
  const long = { ...claimed.params.task, title: "x".repeat(200) };
  const text = previewText("", { kind: "task.claimed", params: { ...claimed.params, task: long } });
  expect(Array.from(text)).toHaveLength(MESSAGE_PREVIEW_MAX_LENGTH);
  expect(text.endsWith("…")).toBe(true);
});

test("a list row carries a notice only when its message is one", () => {
  expect(previewNoticeOf("task.claimed", claimed.params)).toEqual({ notice: claimed });
  expect(previewNoticeOf(null, null)).toEqual({});
});

test("a live activity event keeps a well-formed notice and refuses a malformed one", () => {
  const event = {
    type: "conversation.activity.v1",
    workspaceId: "w",
    conversationId: "c",
    messageId: "m",
    sequence: 1,
    kind: "channel",
    createdAt: "2026-11-02T00:00:00.000Z",
    preview: "notice",
    sender: { kind: "system", name: "System" },
  };
  expect(decodeConversationActivityEvent({ ...event, notice: claimed })?.notice).toEqual(claimed);
  expect(decodeConversationActivityEvent(event)).not.toHaveProperty("notice");
  expect(decodeConversationActivityEvent({ ...event, notice: { kind: "" } })).toBeUndefined();
});
