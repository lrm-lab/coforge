import { expect, test } from "bun:test";

import { resolveAwaitingAssistantResume } from "#src/features/records/record-side-panel-awaiting";

const now = Date.parse("2026-09-18T06:00:00.000Z");

test("resumes from 请稍候 progress comment when agent has not replied", () => {
  const pendingAt = now - 30_000;
  expect(
    resolveAwaitingAssistantResume(
      [
        {
          authorType: "assistant",
          body: "好的，正在根据已有采集包整理周报草稿，请稍候确认。",
          createdAt: new Date(pendingAt).toISOString(),
        },
      ],
      [{ author: "user", createdAt: new Date(pendingAt - 60_000).toISOString() }],
      now,
    ),
  ).toEqual({
    pendingAt,
    label: "好的，正在根据已有采集包整理周报草稿，请稍候确认。",
  });
});

test("uses a memory settlement comment as the running label", () => {
  const pendingAt = now - 20_000;
  expect(
    resolveAwaitingAssistantResume(
      [
        {
          authorType: "assistant",
          body: "正在记录本周写作习惯，请稍候。",
          createdAt: new Date(pendingAt).toISOString(),
        },
      ],
      [],
      now,
    ),
  ).toEqual({ pendingAt, label: "正在记录本周写作习惯，请稍候。" });
});

test("does not keep waiting after the memory settlement comment is finished", () => {
  const userAt = now - 40_000;
  expect(
    resolveAwaitingAssistantResume(
      [
        {
          authorType: "assistant",
          body: "已记录本周写作习惯。",
          createdAt: new Date(now - 10_000).toISOString(),
        },
      ],
      [{ author: "user", createdAt: new Date(userAt).toISOString() }],
      now,
    ),
  ).toBeNull();
});

test("does not resume from 请稍候 after a newer assistant DM reply", () => {
  const pendingAt = now - 30_000;
  expect(
    resolveAwaitingAssistantResume(
      [
        {
          authorType: "assistant",
          body: "采集已完成，正在整理周报草稿，请稍候确认。",
          createdAt: new Date(pendingAt).toISOString(),
        },
      ],
      [
        {
          author: "assistant",
          createdAt: new Date(pendingAt + 5_000).toISOString(),
          suggestion: { kind: "draft" },
        },
      ],
      now,
    ),
  ).toBeNull();
});

test("resumes when latest visible DM turn is still from the user", () => {
  const pendingAt = now - 12_000;
  expect(
    resolveAwaitingAssistantResume(
      [],
      [
        { author: "assistant", createdAt: new Date(pendingAt - 60_000).toISOString() },
        { author: "user", createdAt: new Date(pendingAt).toISOString() },
      ],
      now,
    ),
  ).toEqual({ pendingAt, label: null });
});

test("does not resume when latest DM turn is already an assistant reply", () => {
  expect(
    resolveAwaitingAssistantResume(
      [],
      [
        { author: "user", createdAt: new Date(now - 20_000).toISOString() },
        { author: "assistant", createdAt: new Date(now - 5_000).toISOString() },
      ],
      now,
    ),
  ).toBeNull();
});

test("does not resume after the awaiting window expires", () => {
  const pendingAt = now - 181_000;
  expect(
    resolveAwaitingAssistantResume(
      [
        {
          authorType: "assistant",
          body: "请稍候确认。",
          createdAt: new Date(pendingAt).toISOString(),
        },
      ],
      [{ author: "user", createdAt: new Date(pendingAt).toISOString() }],
      now,
    ),
  ).toBeNull();
});
