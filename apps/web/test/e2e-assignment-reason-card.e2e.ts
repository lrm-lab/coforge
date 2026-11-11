import { expect, test } from "bun:test";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Task #83: an assignment that gives a reason (`task assign --reason`) reads as a card of two
 * lines in the stream, the notice and then the reason, which wraps to three lines at most; an
 * assignment without one keeps its single line, word for word. Worst cases: a long Chinese reason
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
const LONG = `${"这次交接的背景比较长：服务端的指派理由已经存进通知参数，页面需要把它单独成行显示，并且在窄屏上也不能把时间和人名挤掉。".repeat(3)}\n参考 https://staging.coforge.cn/zh-CN/w/default/channel/416fa211-c707-4ec6-be1b-48f108bea322?view=chat&task=310&msg=01a1c82f0a63725897b6c97ffe543edc`;

test("an assignment with a reason is a two-line card; one without keeps its line", async () => {
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
  await fx.send(channelId, DEV_BROWSER_USER.id, `Last ${suffix}`);

  const cards = `[...document.querySelectorAll("[data-assignment-reason-card]")]`;
  const notices = `[...document.querySelectorAll('[data-message="system"]')]`;
  const zh = fx.workspacePath.replace(/^\/en\//, "/zh-CN/");
  for (const [width, height] of [
    ["1440", "900"],
    ["390", "844"],
  ] as const) {
    await fx.browser("set", "viewport", width, height);
    await fx.browser("open", `${fx.proxy.origin}${zh}/channel/${channelId}`);
    await until(`${cards}.length === 2 && ${notices}.length === 3`, 60_000);

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
    // The one without a reason keeps its single line and no card.
    const plain = await evaluate<{ card: boolean; text: string }>(
      `(() => { const row = ${notices}[1]; return { card: row.querySelector("[data-assignment-reason-card]") !== null, text: row.textContent.replace(/\\s+/g, " ") }; })()`,
    );
    expect(plain.card).toBe(false);
    expect(plain.text).toContain("指派给了");
    expect(plain.text).not.toContain("：");
    // The long reason stops at three lines, and no card runs past the page.
    const fit = await evaluate<{ lines: number; overflow: boolean }>(
      `(() => { const reason = ${cards}[1].querySelector("[data-assignment-reason]"); const lineHeight = parseFloat(getComputedStyle(reason).lineHeight); return { lines: Math.round(reason.getBoundingClientRect().height / lineHeight), overflow: ${cards}.some((card) => card.getBoundingClientRect().right > innerWidth) || document.documentElement.scrollWidth > innerWidth }; })()`,
    );
    expect(fit.lines).toBe(3);
    expect(fit.overflow).toBe(false);
  }
}, 240_000);
