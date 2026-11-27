import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { m } from "#src/paraglide/messages";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { animationsSettled, hydratedElement } from "./helpers/browser-e2e";

const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/message-search");

function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the search dialog finds a message and opens it in its channel", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `message-search-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  const box = `document.querySelector('[role="dialog"] input[type="search"]')`;
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;

  const channelId = seededUuid("e2e-message-search:channel");
  const authorUserId = DEV_BROWSER_USER.id;
  const phrase = "验收暗号蓝鲸";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: "e2e-search" },
    });
    await db.conversation.create({
      data: {
        id: channelId,
        workspaceId,
        channelName: "e2e-search",
        description: "",
      },
    });
    const author = await db.conversationMember.create({
      data: {
        conversationId: channelId,
        workspaceId,
        userId: authorUserId,
        leftAt: new Date(),
      },
    });
    const bodies = [
      ...Array.from({ length: 120 }, (_, index) => `filler message ${index + 1}`),
      `今天的${phrase}已经确认，可以发版`,
      ...Array.from({ length: 5 }, (_, index) => `later message ${index + 1}`),
    ];
    const start = Date.now() - bodies.length * 60_000;
    await db.message.createMany({
      data: bodies.map((body, index) => ({
        conversationId: channelId,
        workspaceId,
        senderMemberId: author.id,
        body,
        sequence: index + 1,
        createdAt: new Date(start + index * 60_000),
      })),
    });
    const match = await db.message.findFirstOrThrow({
      where: { conversationId: channelId, body: { contains: phrase } },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}`);
    await browser("eval", "localStorage.clear()");
    const visibleSearchButton = `[...document.querySelectorAll('aside [data-search-button], aside button[aria-label="Search"][aria-haspopup="dialog"]')].find((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().width > 0)`;
    const clickSearchButton = async () => {
      await waitFor(`${visibleSearchButton} != null && ${hydratedElement(visibleSearchButton)}`);
      await browser(
        "eval",
        `(${visibleSearchButton}?.setAttribute("data-e2e-search-trigger", ""), true)`,
      );
      await browser("click", "[data-e2e-search-trigger]");
      await browser(
        "eval",
        `(document.querySelector("[data-e2e-search-trigger]")?.removeAttribute("data-e2e-search-trigger"), true)`,
      );
    };
    await clickSearchButton();
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent.includes("Search everything")`,
    );
    await waitFor(`document.activeElement === ${box}`);
    await browser("screenshot", join(artifacts, "empty.png"));

    await browser("fill", 'input[type="search"]', "蓝鲸");
    await waitFor(`document.querySelector('[role="dialog"] ol li mark') !== null`);
    const result = await evaluate<{
      marks: string[];
      text: string;
      place: string | undefined;
      count: string;
    }>(`(() => {
      const row = document.querySelector('[role="dialog"] ol li');
      return {
        marks: [...row.querySelectorAll("mark")].map((mark) => mark.textContent),
        text: row.textContent,
        place: row.querySelector("[data-channel-name]")?.textContent,
        count: document.querySelector('[role="dialog"] [role="status"]').textContent,
      };
    })()`);
    expect(result.marks).toEqual(["蓝鲸"]);
    expect(result.place).toBe("e2e-search");
    expect(result.text).not.toContain("#e2e-search");
    expect(result.text).toContain(`今天的${phrase}已经确认`);
    expect(result.count).toBe("1 result");
    await browser("screenshot", join(artifacts, "results.png"));

    await browser("click", '[role="dialog"] ol li a');
    await waitFor(
      `location.pathname === "${workspacePath}/channel/${channelId}" && document.querySelector('[role="dialog"]') === null`,
    );
    await waitFor(`document.querySelector('li[data-message-id="${match.id}"]') !== null`);
    await browser("screenshot", join(artifacts, "jumped.png"));

    await clickSearchButton();
    await waitFor(`${box} !== null && ${box}.value === ""`);
    await browser("fill", 'input[type="search"]', "不存在的暗号");
    await waitFor(
      `document.querySelector('[role="dialog"]').textContent.includes("No results for “不存在的暗号”")`,
    );
    await browser("screenshot", join(artifacts, "no-results.png"));

    await browser("eval", `${byText('[role="dialog"] button', "Clear search")}.click()`);
    await waitFor(`${box}.value === ""`);
    await waitFor(`document.activeElement === ${box}`);
    await browser(
      "eval",
      `(() => {
        const input = document.querySelector('[role="dialog"] input[type="search"]');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        for (const value of ["l", "la", "lan", "蓝鲸"]) {
          setValue.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: value }));
        }
        window.__composingSince = Date.now();
      })()`,
    );
    await waitFor(`Date.now() - window.__composingSince > 600`);
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"] [aria-labelledby="search-messages-heading"], [role="dialog"] ol li, [role="dialog"] [aria-busy="true"]') !== null`,
      ),
    ).toBe(false);
    await browser(
      "eval",
      `${box}.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "蓝鲸" }))`,
    );
    await waitFor(`document.querySelector('[role="dialog"] ol li mark')?.textContent === "蓝鲸"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);

test("on a phone searching after backing out jumps to same-channel messages, cached threads, and other conversations", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `message-search-phone-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const waitFor = (condition: string) =>
    Promise.race([
      browser("wait", "--fn", condition, "--timeout", "15000"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), 15_000),
      ),
    ]);

  const channelAId = seededUuid("e2e-message-search:phone-channel-a");
  const channelBId = seededUuid("e2e-message-search:phone-channel-b");
  const dmId = seededUuid("e2e-message-search:phone-dm");
  const agentId = seededUuid("e2e-message-search:phone-agent");
  const token = `手机跳转${process.pid}`;

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;

    await db.conversation
      .deleteMany({ where: { id: { in: [channelAId, channelBId, dmId] } } })
      .catch(() => {});
    await db.conversation
      .deleteMany({
        where: { workspaceId, channelName: { in: ["e2e-phone-a", "e2e-phone-b"] } },
      })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: agentId } }).catch(() => {});

    await db.agent.create({
      data: {
        id: agentId,
        workspaceId,
        name: `e2e-phone-bot-${process.pid}`,
        displayName: "Phone Jump Bot",
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

    await db.conversation.create({
      data: {
        id: channelAId,
        workspaceId,
        channelName: "e2e-phone-a",
        description: "",
        lastSequence: 4,
      },
    });
    const memberA = await db.conversationMember.create({
      data: {
        conversationId: channelAId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: 4,
      },
    });
    await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-filler"),
        conversationId: channelAId,
        workspaceId,
        senderMemberId: memberA.id,
        body: "filler opening line",
        sequence: 1,
      },
    });
    const rootMsg = await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-root"),
        conversationId: channelAId,
        workspaceId,
        senderMemberId: memberA.id,
        body: `${token} 讨论串根消息`,
        sequence: 2,
      },
    });
    const replyMsg = await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-reply"),
        conversationId: channelAId,
        workspaceId,
        senderMemberId: memberA.id,
        threadRootId: rootMsg.id,
        body: `${token} 串内回复跳转`,
        sequence: 3,
      },
    });
    const chanAMsg = await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-chan-a-msg"),
        conversationId: channelAId,
        workspaceId,
        senderMemberId: memberA.id,
        body: `${token} 同频道消息跳转`,
        sequence: 4,
      },
    });

    await db.conversation.create({
      data: {
        id: channelBId,
        workspaceId,
        channelName: "e2e-phone-b",
        description: "",
        lastSequence: 1,
      },
    });
    const memberB = await db.conversationMember.create({
      data: {
        conversationId: channelBId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: 1,
      },
    });
    const chanBMsg = await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-chan-b-msg"),
        conversationId: channelBId,
        workspaceId,
        senderMemberId: memberB.id,
        body: `${token} 跨频道消息跳转`,
        sequence: 1,
      },
    });

    await db.conversation.create({
      data: {
        id: dmId,
        workspaceId,
        directKey: `agent:${agentId}|user:${DEV_BROWSER_USER.id}`,
        lastSequence: 1,
      },
    });
    await db.conversationMember.create({
      data: {
        conversationId: dmId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: 1,
      },
    });
    const agentDmMember = await db.conversationMember.create({
      data: {
        conversationId: dmId,
        workspaceId,
        agentId,
        readThroughSequence: 1,
      },
    });
    const dmMsg = await db.message.create({
      data: {
        id: seededUuid("e2e-message-search:phone-dm-msg"),
        conversationId: dmId,
        workspaceId,
        senderMemberId: agentDmMember.id,
        body: `${token} 私聊消息跳转`,
        sequence: 1,
      },
    });

    const backSel = `button[aria-label=${JSON.stringify(m.conversation_back_to_list())}]`;
    const closeSel = `button[aria-label=${JSON.stringify(m.conversation_thread_back())}]`;

    const backToListAndOpen = async (query: string, selector: string) => {
      await waitFor(
        `document.querySelector(${JSON.stringify(backSel)}) !== null && ${animationsSettled({ allowInfinite: true })}`,
      );
      await browser("click", backSel);
      await waitFor(
        `document.querySelector('[data-phone-stack-root]') !== null && ${animationsSettled({ allowInfinite: true })}`,
      );
      await waitFor(
        `document.querySelector('[data-search-button]') !== null && ${hydratedElement("document.querySelector('[data-search-button]')")}`,
      );
      await browser("click", "[data-search-button]");
      await waitFor(`document.querySelector('[role="dialog"] input[type="search"]') !== null`);
      await browser("fill", '[role="dialog"] input[type="search"]', query);
      await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
      await browser("click", selector);
    };
    const backToListAndSearch = (query: string, messageId: string) =>
      backToListAndOpen(query, `[data-search-message-id="${messageId}"]`);

    const assertLanded = async (expectedPath: string, messageId: string) => {
      await waitFor(
        `location.pathname === "${expectedPath}" && document.querySelector('[role="dialog"]') === null && document.querySelector('[data-phone-stack-root]') === null && document.querySelector('[data-chat-list]')?.hasAttribute('inert') === true`,
      );
      await waitFor(animationsSettled({ allowInfinite: true }));
      const landed = await evaluate<{
        found: boolean;
        inert: boolean;
        left: number;
        right: number;
        top: number;
        bottom: number;
        innerHeight: number;
      }>(`(() => {
        const el = document.querySelector('li[data-message-id="${messageId}"]');
        const r = el?.getBoundingClientRect();
        return {
          found: Boolean(el),
          inert: el ? el.closest('[inert]') !== null : true,
          left: r ? Math.round(r.left) : -1,
          right: r ? Math.round(r.right) : 999,
          top: r ? Math.round(r.top) : -1,
          bottom: r ? Math.round(r.bottom) : 999,
          innerHeight: window.innerHeight,
        };
      })()`);
      expect(landed.found).toBe(true);
      expect(landed.inert).toBe(false);
      expect(landed.left).toBeGreaterThanOrEqual(0);
      expect(landed.right).toBeLessThanOrEqual(390);
      expect(landed.bottom).toBeGreaterThan(0);
      expect(landed.top).toBeLessThan(landed.innerHeight);
    };

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/channel/${channelAId}`);
    await waitFor(`document.querySelector(${JSON.stringify(backSel)}) !== null`);

    await backToListAndSearch(`${token} 同频道消息跳转`, chanAMsg.id);
    await assertLanded(`${workspacePath}/channel/${channelAId}`, chanAMsg.id);
    await browser("screenshot", join(artifacts, "phone-same-channel.png"));

    await backToListAndOpen("e2e-phone-a", `[data-search-entity="channel:${channelAId}"]`);
    await assertLanded(`${workspacePath}/channel/${channelAId}`, chanAMsg.id);

    await backToListAndSearch(`${token} 串内回复跳转`, replyMsg.id);
    await assertLanded(`${workspacePath}/channel/${channelAId}`, replyMsg.id);

    await waitFor(`document.querySelector(${JSON.stringify(closeSel)}) !== null`);
    await browser(
      "eval",
      `[...document.querySelectorAll(${JSON.stringify(closeSel)})].at(-1)?.click()`,
    );
    await waitFor(`!new URLSearchParams(location.search).has("threadRootId")`);

    await backToListAndSearch(`${token} 串内回复跳转`, replyMsg.id);
    await assertLanded(`${workspacePath}/channel/${channelAId}`, replyMsg.id);
    await browser("screenshot", join(artifacts, "phone-cached-thread.png"));

    await waitFor(`document.querySelector(${JSON.stringify(closeSel)}) !== null`);
    await browser(
      "eval",
      `[...document.querySelectorAll(${JSON.stringify(closeSel)})].at(-1)?.click()`,
    );
    await waitFor(`!new URLSearchParams(location.search).has("threadRootId")`);

    await backToListAndSearch(`${token} 跨频道消息跳转`, chanBMsg.id);
    await assertLanded(`${workspacePath}/channel/${channelBId}`, chanBMsg.id);

    await backToListAndSearch(`${token} 私聊消息跳转`, dmMsg.id);
    await assertLanded(`${workspacePath}/dm/${dmId}`, dmMsg.id);

    await backToListAndSearch(`${token} 私聊消息跳转`, dmMsg.id);
    await assertLanded(`${workspacePath}/dm/${dmId}`, dmMsg.id);
    await browser("screenshot", join(artifacts, "phone-dm.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelAId, channelBId, dmId] } } })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
