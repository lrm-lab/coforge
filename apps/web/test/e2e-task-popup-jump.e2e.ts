import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { CONVERSATION_WINDOW_PAGE_SIZE } from "#src/lib/conversation-window";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * A Task popup offers a way down only to new replies: a reader who scrolls up through a discussion
 * with nothing unread gets no "Jump to latest", whether it overflows or fits again (task
 * #coforge-ui:#10). Screenshots go under `.artifacts/e2e/task-popup-jump/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL!;
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/task-popup-jump");

test("a Task popup hides Jump to latest when read and returns to its title across pagination", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-jump-${process.pid}`);
  let discussionId: string | undefined;
  let pageReads = 0;
  let olderPage: Promise<void> | undefined;
  let releaseOlder: (() => void) | undefined;
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {
    async afterUpstream(url) {
      if (
        discussionId &&
        url.search.includes(discussionId) &&
        url.pathname.includes("_serverFn") &&
        decodeURIComponent(url.search).includes('"beforeSequence"')
      ) {
        pageReads++;
        await olderPage;
      }
    },
  });
  const { origin } = proxy;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-jump-${tail}`,
      displayName: `Task Agent ${tail}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-jump-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  try {
    const created = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      operation: "create",
      titles: [`Check the sign-up flow ${tail}`],
      assignee: `agent:${agent.id}`,
    } as Parameters<TaskBoard["execute"]>[1]);
    const number = created.tasks[0]!.number;
    const centrifugo = createCentrifugoServerApi();
    const conversations = new TaskConversations(
      {
        db,
        reader: "agent",
        dependencies: {
          publisher: centrifugo,
          realtime: new CentrifugoConversationRealtime(centrifugo),
        },
      },
      getMessageRequestIdempotency(),
    );
    await conversations.reply(
      { workspaceId, agentId: agent.id },
      { target: `#${channel.channelName}`, number },
      { idempotencyKey: crypto.randomUUID(), body: `The sign-up flow works ${tail}`, mentions: [] },
    );
    await mkdir(artifacts, { recursive: true });
    const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}?task=${number}`;
    const history = `document.querySelector('[role="dialog"] [data-scroll-restoration-id]')`;
    const backToTop = `document.querySelector('[role="dialog"] button[aria-label="Back to top"]')`;
    const backToBottom = `([...document.querySelectorAll('[role="dialog"] button')].find((b) => /^jump to latest$/i.test(b.textContent.trim())) ?? null)`;
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${history}?.textContent.includes("The sign-up flow works ${tail}")`,
    );
    // A short discussion, at the latest: nothing to go back to.
    expect(await evaluate<boolean>(`${backToBottom} === null`)).toBe(true);
    expect(await evaluate<boolean>(`${backToTop} === null`)).toBe(true);
    // The pane narrows until it overflows (a long draft, a status bar) and the reader goes up.
    await evaluate(`(${history}.style.maxHeight = "60px", true)`);
    await browser("wait", "--fn", `${history}.scrollHeight > ${history}.clientHeight + 48`);
    await browser(
      "wait",
      "--fn",
      `(() => {
      const pane = ${history};
      pane.style.maxHeight = "60px";
      pane.scrollTop = 8;
      return pane.scrollTop === 8 && ${backToTop}?.disabled === false;
    })()`,
    );
    expect(await evaluate<string>(`${backToTop}.innerText.trim()`)).toBe("Back to top");
    await evaluate(`(${backToTop}.focus(), true)`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `${history}.scrollTop === 0 && ${backToTop} === null`);
    await evaluate(`(${history}.scrollTop = ${history}.scrollHeight, true)`);
    await browser("wait", "--fn", `${history}.scrollTop > 48`);
    await evaluate(
      `(${history}.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true })), ${history}.scrollTop = 0, true)`,
    );
    await browser("wait", "500");
    expect(await evaluate<boolean>(`${backToBottom} === null`)).toBe(true);
    await evaluate(`(${history}.style.maxHeight = "", true)`);
    await browser("wait", "500");
    expect(await evaluate<boolean>(`${backToBottom} === null`)).toBe(true);
    await browser("screenshot", join(artifacts, "fits.png"));

    const firstReply = await db.message.findFirstOrThrow({
      where: { body: `The sign-up flow works ${tail}`, workspaceId, sender: { agentId: agent.id } },
    });
    discussionId = firstReply.conversationId;
    const count = 160;
    const last = firstReply.sequence + count;
    await db.$transaction([
      db.conversationMember.createMany({
        data: [
          { workspaceId, conversationId: firstReply.conversationId, userId: DEV_BROWSER_USER.id },
        ],
        skipDuplicates: true,
      }),
      db.conversationMember.updateMany({
        where: { conversationId: firstReply.conversationId, userId: DEV_BROWSER_USER.id },
        data: { readThroughSequence: last - 5 },
      }),
      db.message.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          workspaceId,
          conversationId: firstReply.conversationId,
          senderMemberId: firstReply.senderMemberId,
          sequence: firstReply.sequence + index + 1,
          body: `Discussion reply ${index + 1}: review the sign-up flow.\n\nVerify that the title remains visible.\n\nCheck the desktop layout.\n\nCheck the phone layout.\n\nRecord the result.`,
        })),
      }),
      db.conversation.update({
        where: { id: firstReply.conversationId },
        data: { lastSequence: last },
      }),
    ]);
    await browser("reload");
    const row = `${history}.querySelector("li[data-message-id]")`;
    const rowTop = (id: string) =>
      `${history}.querySelector('[data-message-id="${id}"] [data-scroll-anchor]').getBoundingClientRect().top`;
    const firstId = `${row}.dataset.messageId`;
    const loadingOlder = `${history}.textContent.includes("Loading older messages")`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && Boolean(${history}?.querySelector("li[data-message-id]"))`,
    );
    const newest = `[...document.querySelectorAll('[role="dialog"] button')].find(b => /new messages$/i.test(b.textContent.trim()))`;
    await browser("wait", "--fn", `Boolean(${newest})`);
    await evaluate(`(${newest}.click(), true)`);
    const rowCount = `${history}.querySelectorAll('li[data-message-id]').length`;
    await browser(
      "wait",
      "--fn",
      `${history}.textContent.includes("Discussion reply ${count}:") && ${history}.scrollTop > 0`,
    );
    expect(await evaluate<number>(rowCount)).toBe(CONVERSATION_WINDOW_PAGE_SIZE);
    for (const action of ["click", "manual", "in-flight"] as const) {
      if (action !== "manual") {
        await evaluate(`(${history}.scrollTop = ${history}.scrollHeight, true)`);
        await browser("wait", "--fn", `Boolean(${backToTop})`);
      }
      olderPage = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      const readsBefore = pageReads;
      const rowsBefore = await evaluate<number>(rowCount);
      const original = await evaluate<string>(firstId);
      if (action === "manual") {
        await evaluate(
          `(${history}.scrollTop += ${row}.getBoundingClientRect().top - ${history}.getBoundingClientRect().top + 80, true)`,
        );
        await browser("wait", "--fn", `Boolean(${backToTop})`);
        expect(
          await evaluate<number>(
            `${history}.getBoundingClientRect().top - ${history}.querySelector("[data-scroll-older]").getBoundingClientRect().bottom`,
          ),
        ).toBeLessThan(600);
        await evaluate(`(${history}.scrollBy(0, -40), true)`);
        await browser("wait", "--fn", loadingOlder);
      }
      if (action === "in-flight") {
        await evaluate(
          `(${history}.scrollTop += ${row}.getBoundingClientRect().top - ${history}.getBoundingClientRect().top, true)`,
        );
        await browser("wait", "--fn", loadingOlder);
      }
      const previousY = await evaluate<number>(rowTop(original));
      if (action !== "manual") {
        await browser("click", 'button[aria-label="Back to top"]');
        await browser("wait", "--fn", loadingOlder);
      }
      releaseOlder?.();
      await browser("wait", "--fn", `${firstId} !== "${original}"`);
      await browser(
        "eval",
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`,
      );
      expect(await evaluate<boolean>(loadingOlder)).toBe(false);
      expect(pageReads - readsBefore).toBe(1);
      expect(await evaluate<number>(rowCount)).toBe(rowsBefore + CONVERSATION_WINDOW_PAGE_SIZE);
      if (action === "manual") {
        expect(
          Math.abs((await evaluate<number>(rowTop(original))) - previousY),
        ).toBeLessThanOrEqual(1);
      } else {
        await browser("wait", "--fn", `${history}.scrollTop === 0 && ${backToTop} === null`);
        const visible = await evaluate<boolean>(
          `(() => { const pane = ${history}.getBoundingClientRect(); const title = ${history}.querySelector("h2").getBoundingClientRect(); return title.top >= pane.top && title.bottom <= pane.bottom; })()`,
        );
        expect(visible).toBe(true);
      }
    }
  } finally {
    releaseOlder?.();
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.message
      .deleteMany({ where: { sender: { agentId: agent.id } } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
