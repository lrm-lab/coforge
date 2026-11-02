import { afterEach, describe, expect, test } from "bun:test";

import { overwriteGetLocale } from "#src/paraglide/runtime";

import type { SystemNotice } from "./system-notice";
import { systemNoticeText } from "./system-notice-text";

const frank = { memberId: "m-frank", handle: "frank-an", displayName: "Frank An" };
const coder = { memberId: "m-coder", handle: "coder", displayName: "Coder" };
const old = { memberId: null, handle: "old", displayName: "Old" };
const task = { taskId: "t-4", number: 4, title: "Fix login" };
const other = { taskId: "t-5", number: 5, title: "Ship it" };

const read = (system: SystemNotice, body = "stored English body") =>
  systemNoticeText({ body, system });

/** Each kind as the en and zh-CN viewer reads it (task #185; zh wording settled by Raft). */
const CASES: [SystemNotice, string, string][] = [
  [
    { kind: "task.created", params: { tasks: [task] } },
    '📋 1 new task created: #4 "Fix login"',
    "📋 新建了 1 个任务：#4「Fix login」",
  ],
  [
    { kind: "task.created", params: { tasks: [task, other] } },
    '📋 2 new tasks created: #4 "Fix login", #5 "Ship it"',
    "📋 新建了 2 个任务：#4「Fix login」、#5「Ship it」",
  ],
  [
    { kind: "task.converted", params: { actor: frank, task } },
    '📋 Frank An converted a message to task #4 "Fix login"',
    "📋 Frank An 把一条消息转成了任务 #4「Fix login」",
  ],
  [
    { kind: "task.from_message", params: { actor: frank, task } },
    '📋 Frank An made task #4 "Fix login" from this message',
    "📋 Frank An 用这条消息建了任务 #4「Fix login」",
  ],
  [
    { kind: "task.assigned", params: { actor: frank, task, assignee: coder } },
    '📌 Frank An assigned #4 "Fix login" to @coder',
    "📌 Frank An 把任务 #4「Fix login」指派给了 @coder",
  ],
  [
    { kind: "task.claimed", params: { claimer: frank, task } },
    '📌 Frank An claimed #4 "Fix login"',
    "📌 Frank An 认领了任务 #4「Fix login」",
  ],
  [
    { kind: "task.moved", params: { actor: frank, task, status: "in_progress" } },
    '🔄 Frank An moved #4 "Fix login" to In progress',
    "🔄 Frank An 把任务 #4「Fix login」移到了进行中",
  ],
  [
    { kind: "task.moved", params: { actor: frank, task, status: "done" } },
    '✅ Frank An moved #4 "Fix login" to Done',
    "✅ Frank An 把任务 #4「Fix login」移到了已完成",
  ],
  [
    { kind: "task.unassigned", params: { actor: frank, task } },
    '🔓 Frank An unassigned #4 "Fix login"',
    "🔓 Frank An 取消了任务 #4「Fix login」的指派",
  ],
  [
    { kind: "task.unfollowed", params: { actor: frank, task } },
    "Frank An stopped following this task.",
    "Frank An 不再关注这个任务",
  ],
  [
    { kind: "task.unfollowed", params: { actor: frank, task, reason: "done with it" } },
    "Frank An stopped following this task: done with it.",
    "Frank An 不再关注这个任务：done with it",
  ],
  [
    { kind: "task.assigned_you", params: { actor: frank, task } },
    'Frank An assigned you task #4 "Fix login"',
    "Frank An 给你指派了任务 #4「Fix login」",
  ],
  [
    {
      kind: "channel.coordinator_changed",
      params: { channelId: "c-1", channelName: "team", actor: frank, next: coder },
    },
    "Frank An made @coder the coordinator of #team",
    "Frank An 把 @coder 设为 #team 的协调员",
  ],
  [
    {
      kind: "channel.coordinator_changed",
      params: { channelId: "c-1", channelName: "team", actor: frank, next: coder, previous: old },
    },
    "Frank An made @coder the coordinator of #team (replacing @old)",
    "Frank An 把 @coder 设为 #team 的协调员（替换 @old）",
  ],
  [
    {
      kind: "channel.coordinator_changed",
      params: { channelId: "c-1", channelName: "team", actor: frank, previous: old },
    },
    "Frank An removed @old as coordinator of #team",
    "Frank An 取消了 @old 在 #team 的协调员身份",
  ],
];

describe("a system notice in the viewer's language", () => {
  afterEach(() => overwriteGetLocale(() => "en"));

  test("every kind reads in English", () => {
    overwriteGetLocale(() => "en");
    for (const [system, en] of CASES) expect(read(system)).toBe(en);
  });

  test("every kind reads in Chinese, with no English left in it", () => {
    overwriteGetLocale(() => "zh-CN");
    for (const [system, , zh] of CASES) expect(read(system)).toBe(zh);
    expect(read({ kind: "agent_dm.chain_limit", params: {} })).toStartWith("[CoForge 已暂停]");
    expect(read({ kind: "agent_dm.rate_limit", params: {} })).toStartWith("[CoForge 已暂停]");
  });

  test("a backfilled task with no id reads like any other", () => {
    overwriteGetLocale(() => "zh-CN");
    const backfilled = { ...task, taskId: null };
    expect(read({ kind: "task.claimed", params: { claimer: frank, task: backfilled } })).toBe(
      "📌 Frank An 认领了任务 #4「Fix login」",
    );
  });

  test("a task with no title is its number", () => {
    overwriteGetLocale(() => "zh-CN");
    const untitled = { ...task, title: "" };
    expect(read({ kind: "task.claimed", params: { claimer: frank, task: untitled } })).toBe(
      "📌 Frank An 认领了任务 #4",
    );
  });

  test("an unstructured, unknown or malformed notice reads as its stored body", () => {
    overwriteGetLocale(() => "zh-CN");
    expect(systemNoticeText({ body: "Frank joined the channel." })).toBe(
      "Frank joined the channel.",
    );
    expect(read({ kind: "legacy_text", params: { body: "old text" } }, "old text")).toBe(
      "old text",
    );
    expect(
      systemNoticeText({ body: "kept", system: { kind: "task.claimed", params: { task } } }),
    ).toBe("kept");
    expect(systemNoticeText({ body: "kept", system: { kind: "task.renamed", params: {} } })).toBe(
      "kept",
    );
  });
});

test("a Chinese recipient reads a list of newly created tasks in Chinese", () => {
  const text = systemNoticeText(
    {
      body: '📋 2 new tasks created: #1 "A", #2 "B"',
      system: {
        kind: "task.created",
        params: {
          tasks: [
            { taskId: null, number: 1, title: "A" },
            { taskId: null, number: 2, title: "B" },
          ],
        },
      },
    },
    "zh-CN",
  );
  expect(text).toMatch(/\p{Script=Han}/u);
  expect(text).not.toContain("new tasks");
  expect(text).toContain("A");
  expect(text).toContain("B");
});
