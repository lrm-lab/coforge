import { expect, test } from "bun:test";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Task #83 gave an assignment a reason (`task assign --reason`); task #92 shows every assignment
 * notice as its one line, word for word whether or not it has a reason: the reason is for the
 * assignee, not the stream (Frank: "直接不显示reason"), so neither the line nor its tooltip shows
 * it. A Task's creation notice to its assignee names who it went to (an older one, which stored no
 * assignee, keeps its "you"). Worst case: the longest reason the CLI takes. Screenshots at 1440 and
 * 390, light and dark, are written under `.amp/e2e/assignment-notice/`.
 */
const fx = setupAgentReplying({ artifactsName: "assignment-notice" });
const { suffix, evaluate, until } = fx;

const frank = { memberId: null, handle: "frank-an", displayName: "Frank An" };
const coder = { memberId: null, handle: "coder", displayName: "Coder" };
const task = (number: number, title: string) => ({
  taskId: crypto.randomUUID(),
  number,
  title,
});

async function notice(conversationId: string, body: string, system: SystemNotice) {
  await fx.db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, conversationId);
    const message = await tx.message.create({
      data: {
        workspaceId: fx.workspaceId,
        conversationId,
        senderMemberId: null,
        sequence,
        body,
      },
    });
    await tx.systemMessage.create({
      data: {
        messageId: message.id,
        conversationId,
        workspaceId: fx.workspaceId,
        kind: system.kind,
        params: system.params,
      },
    });
  });
}

const SHORT = "后端已经好了，请接着做页面部分";
/** The longest reason the CLI takes: one line of 200 characters (`TASK_ASSIGN_REASON_MAX_LENGTH`). */
const LONG =
  "这次交接需要你接着做页面部分：服务端已经把指派理由存进通知参数，前端要把它单独成行显示，桌面和手机都要看得清楚；超长的理由不能把时间、人名和任务编号挤掉，深色模式下的对比度也要检查，完成后在任务里贴同尺寸的对比图并说明改动范围与测试结果，谢谢。"
    .repeat(2)
    .slice(0, 200);

test("an assignment notice is one line and never shows its reason", async () => {
  const channelId = await fx.createChannel(`e2e-assign-reason-${suffix}`);
  const login = task(4, "修复登录");
  const page = task(5, "Make the task popup's phone layout work at 320 wide and keep the bar");
  await fx.send(channelId, DEV_BROWSER_USER.id, `First ${suffix}`);
  await notice(channelId, `📌 frank-an assigned #4 "修复登录" to @coder: ${SHORT}`, {
    kind: "task.assigned",
    params: { actor: frank, task: login, assignee: coder, reason: SHORT },
  });
  // People messages between the notices, so each stands alone rather than folding into a run.
  await fx.send(channelId, DEV_BROWSER_USER.id, `Second ${suffix}`);
  await notice(channelId, '📌 frank-an assigned #4 "修复登录" to @coder', {
    kind: "task.assigned",
    params: { actor: frank, task: login, assignee: coder },
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `Third ${suffix}`);
  await notice(channelId, `📌 frank-an assigned #5 to @coder: ${LONG}`, {
    kind: "task.assigned",
    params: { actor: frank, task: page, assignee: coder, reason: LONG },
  });
  // A blank reason (only the CLI refuses one): no dangling colon.
  await fx.send(channelId, DEV_BROWSER_USER.id, `Fourth ${suffix}`);
  await notice(channelId, '📌 frank-an assigned #4 "修复登录" to @coder:    ', {
    kind: "task.assigned",
    params: { actor: frank, task: login, assignee: coder, reason: "   " },
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `Fifth ${suffix}`);
  await notice(channelId, `@frank-an assigned you task #4: 修复登录`, {
    kind: "task.assigned_you",
    params: { actor: frank, task: login, assignee: coder },
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `Sixth ${suffix}`);
  await notice(channelId, `@frank-an assigned you task #4: 修复登录`, {
    kind: "task.assigned_you",
    params: { actor: frank, task: login },
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `Last ${suffix}`);

  const notices = `[...document.querySelectorAll('[data-message="system"]')]`;
  const textOf = (index: number) =>
    evaluate<string>(`${notices}[${index}].textContent.replace(/\\s+/g, " ").trim()`);
  const zh = fx.workspacePath.replace(/^\/en\//, "/zh-CN/");
  for (const [width, height] of [
    ["1440", "900"],
    ["390", "844"],
  ] as const) {
    await fx.browser("set", "viewport", width, height);
    await fx.browser("open", `${fx.proxy.origin}${zh}/channel/${channelId}`);
    await until(`${notices}.length === 6`, 60_000);

    await evaluate(`${notices}[0].scrollIntoView({ block: "center" }) ?? true`);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}.png`);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}-dark.png`);
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // Every assignment reads the same, reason or not: "… 指派给了 coder", nothing after it.
    for (const index of [0, 1, 2, 3]) {
      const text = await textOf(index);
      expect(text).toContain("指派给了");
      expect(text).toEndWith("coder");
      expect(text).not.toContain("：");
    }
    expect(
      await evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(SHORT)})`),
    ).toBe(false);
    // A creation notice that names its assignee reads as any assignment; an older one keeps "you".
    const named = await textOf(4);
    expect(named).toContain("📌");
    expect(named).toContain("指派给了");
    expect(named).toEndWith("coder");
    expect(named).not.toContain("你");
    expect(await textOf(5)).toContain("给你指派了");
    // Each notice is one line, and nothing runs past the page.
    expect(
      await evaluate<boolean>(
        `${notices}.every((row) => { const line = row.querySelector("time").parentElement; return Math.round(line.getBoundingClientRect().height) <= Math.ceil(parseFloat(getComputedStyle(line).lineHeight)) + 1; }) && document.documentElement.scrollWidth <= innerWidth`,
      ),
    ).toBe(true);
  }
}, 240_000);
