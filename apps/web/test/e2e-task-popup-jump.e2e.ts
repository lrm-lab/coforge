import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
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

test("a Task popup offers no Jump to latest when nothing is unread", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-popup-jump-${process.pid}`);
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
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
    await browser("wait", "--fn", `${pageHydrated} && ${history}?.textContent.includes("${tail}")`);
    // A short discussion, at the latest: nothing to go back to.
    expect(await evaluate<boolean>(`${backToBottom} === null`)).toBe(true);
    expect(await evaluate<boolean>(`${backToTop} === null`)).toBe(true);
    // The pane narrows until it overflows (a long draft, a status bar) and the reader goes up.
    await evaluate(`(${history}.style.maxHeight = "60px", true)`);
    await browser("wait", "--fn", `${history}.scrollHeight > ${history}.clientHeight + 48`);
    await evaluate(`(${history}.scrollTop = 8, true)`);
    await browser("wait", "--fn", `${backToTop}?.disabled === false`);
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
  } finally {
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
