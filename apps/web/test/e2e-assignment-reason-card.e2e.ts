import { expect, test } from "bun:test";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Task #83: an assignment that gives a reason (`task assign --reason`) reads as two lines in the
 * stream, the notice and then the reason, which wraps to three lines at most; an assignment without
 * one keeps its single line, word for word. Task #92: both are the same plain notice row, no card,
 * and a Task's creation notice to its assignee names who it went to (an older one, which stored no
 * assignee, keeps its "you"). Worst cases: a long Chinese reason
 * with an unbroken URL and a line break. Screenshots at 1440 and 390, light and dark, are written
 * under `.amp/e2e/assignment-reason-card/`.
 */
const fx = setupAgentReplying({ artifactsName: "assignment-reason-card" });
const { suffix, evaluate, until } = fx;

const frank = { memberId: null, handle: "frank-an", displayName: "Frank An" };
const coder = { memberId: null, handle: "coder", displayName: "Coder" };
const task = (number: number, title: string) => ({ taskId: crypto.randomUUID(), number, title });

async function notice(conversationId: string, body: string, system: SystemNotice) {
  await fx.db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, conversationId);
    const message = await tx.message.create({
      data: { workspaceId: fx.workspaceId, conversationId, senderMemberId: null, sequence, body },
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

test("an assignment with a reason is two plain lines; one without keeps its line", async () => {
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
  // A blank reason (only the CLI refuses one) reads as no reason: no card, no dangling colon.
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

  const cards = `[...document.querySelectorAll("[data-assignment-with-reason]")]`;
  const notices = `[...document.querySelectorAll('[data-message="system"]')]`;
  const zh = fx.workspacePath.replace(/^\/en\//, "/zh-CN/");
  for (const [width, height] of [
    ["1440", "900"],
    ["390", "844"],
  ] as const) {
    await fx.browser("set", "viewport", width, height);
    await fx.browser("open", `${fx.proxy.origin}${zh}/channel/${channelId}`);
    await until(`${cards}.length === 2 && ${notices}.length === 6`, 60_000);

    await evaluate(`${cards}[0].scrollIntoView({ block: "center" }) ?? true`);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}.png`);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}-dark.png`);
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // The card's first line is the notice without the reason; the second is the reason.
    const firstLines = await evaluate<string[]>(
      `${cards}.map((card) => card.firstElementChild.textContent.replace(/\\s+/g, " "))`,
    );
    for (const line of firstLines) {
      expect(line).toContain("指派给了");
      expect(line).not.toContain("：");
    }
    expect(
      await evaluate<string[]>(
        `${cards}.map((card) => card.querySelector("[data-assignment-reason]").textContent)`,
      ),
    ).toEqual([SHORT, LONG]);
    // The ones without a reason, or with a blank one, keep their single line and no card.
    for (const index of [1, 3]) {
      const plain = await evaluate<{ card: boolean; text: string }>(
        `(() => { const row = ${notices}[${index}]; return { card: row.querySelector("[data-assignment-with-reason]") !== null, text: row.textContent.replace(/\\s+/g, " ").trim() }; })()`,
      );
      expect(plain.card).toBe(false);
      expect(plain.text).toEndWith("coder");
      expect(plain.text).not.toContain("：");
    }
    // No card: neither line, nor what holds them, draws a frame or a fill (task #92).
    expect(
      await evaluate<boolean>(
        `${cards}.every((row) => { const reason = row.querySelector("[data-assignment-reason]"); return [row, row.firstElementChild, row.querySelector("[data-assignment-notice]"), reason, reason.parentElement].every((e) => { const s = getComputedStyle(e); return parseFloat(s.borderTopWidth) === 0 && s.backgroundColor === "rgba(0, 0, 0, 0)"; }); })`,
      ),
    ).toBe(true);
    // A creation notice that names its assignee reads as any assignment; an older one keeps "you".
    const textOf = (index: number) =>
      evaluate<string>(`${notices}[${index}].textContent.replace(/\\s+/g, " ").trim()`);
    const named = await textOf(4);
    expect(named).toContain("📌");
    expect(named).toContain("指派给了");
    expect(named).toEndWith("coder");
    expect(named).not.toContain("你");
    expect(await textOf(5)).toContain("给你指派了");
    // The long reason stops at three lines, and no row runs past the page.
    const fit = await evaluate<{ lines: number; overflow: boolean }>(
      `(() => { const reason = ${cards}[1].querySelector("[data-assignment-reason]"); const lineHeight = parseFloat(getComputedStyle(reason).lineHeight); return { lines: Math.round(reason.getBoundingClientRect().height / lineHeight), overflow: ${cards}.some((card) => card.getBoundingClientRect().right > innerWidth) || document.documentElement.scrollWidth > innerWidth }; })()`,
    );
    expect(fit.lines).toBe(3);
    expect(fit.overflow).toBe(false);
    // A short reason is plain text; a clamped one is a control that shows it whole in place,
    // since a phone has no hover for a tooltip.
    const reasonButton = (index: number) =>
      `${cards}[${index}].querySelector('button[aria-expanded]')`;
    expect(await evaluate<boolean>(`${reasonButton(0)} === null`)).toBe(true);
    // Once open it is plain text again, which can be selected and copied.
    await evaluate(`${reasonButton(1)}.click() ?? true`);
    await until(`${reasonButton(1)} === null`);
    expect(
      await evaluate<number>(
        `(() => { const reason = ${cards}[1].querySelector("[data-assignment-reason]"); return Math.round(reason.getBoundingClientRect().height / parseFloat(getComputedStyle(reason).lineHeight)); })()`,
      ),
    ).toBeGreaterThan(3);
  }
}, 240_000);
