import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { AGENT_THREAD_UNFOLLOWED_SYSTEM_MESSAGE_KIND } from "#src/server/conversations/channel-threads.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The "N seen" list of an own message names each Agent the message never reached, and why: a
 * muted channel for a top-level message, an unfollowed thread for a thread reply, which offers the
 * list though it has no ticks (task #89). Desktop menu and phone action sheet. Needs a local built
 * Web with skip-auth, PostgreSQL and agent-browser; no model runs. Removes its own Workspace and
 * Computer.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const { browser, evaluate } = browserSession(browserPath, `seen-by-undelivered-${process.pid}`);
const runtimeConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "e2e-model",
  modelProvider: "e2e-provider",
  reasoning: "balanced",
};
let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
let channelId: string;
let rootId: string;
let topId: string;
let replyId: string;

beforeAll(async () => {
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Seen-by reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Seen-by undelivered",
      slug: `seen-by-undelivered-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `seen-by-undelivered-${process.pid}` },
  });
  computerId = computer.id;
  const agent = (name: string, displayName: string) =>
    db.agent.create({
      data: {
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        computerId,
        name,
        visibility: "public",
        displayName,
        runtimeConfig,
      },
    });
  const reader = await agent("e2e-reader", "Reader Agent");
  const muted = await agent("e2e-muted", "Muted Agent");
  const unfollower = await agent("e2e-unfollower", "Unfollower Agent");
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: "seen-by-undelivered",
      description: "",
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, joinedAt: new Date(Date.now() - 3_600_000) },
          { agentId: reader.id },
          { agentId: muted.id, notificationLevel: "muted" },
          { agentId: unfollower.id },
        ],
      },
    },
  });
  channelId = channel.id;
  const member = (where: { userId?: string; agentId?: string }) =>
    db.conversationMember.findFirstOrThrow({ where: { conversationId: channelId, ...where } });
  const me = await member({ userId: DEV_BROWSER_USER.id });
  const unfollowerMember = await member({ agentId: unfollower.id });
  let sequence = 0;
  const post = (data: { body: string; senderMemberId?: string; threadRootId?: string }) =>
    db.message.create({
      data: { workspaceId, conversationId: channelId, sequence: ++sequence, ...data },
    });
  const root = await post({ body: "E2E thread root", senderMemberId: me.id });
  rootId = root.id;
  await post({
    body: "E2E agent reply",
    senderMemberId: unfollowerMember.id,
    threadRootId: rootId,
  });
  // The structured notice an Agent's unfollow leaves (`setThreadFollowed`): the record seen-by reads.
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      sequence: ++sequence,
      body: "Unfollower Agent unfollowed this thread",
      systemMessage: {
        create: {
          kind: AGENT_THREAD_UNFOLLOWED_SYSTEM_MESSAGE_KIND,
          params: { agentId: unfollower.id, rootMessageId: rootId },
          conversation: { connect: { id_workspaceId: { id: channelId, workspaceId } } },
        },
      },
    },
  });
  replyId = (
    await post({ body: "E2E own thread reply", senderMemberId: me.id, threadRootId: rootId })
  ).id;
  const top = await post({ body: "E2E own top-level message", senderMemberId: me.id });
  topId = top.id;
  await db.conversation.update({ where: { id: channelId }, data: { lastSequence: sequence } });
  await db.conversationMember.update({
    where: { id: (await member({ agentId: reader.id })).id },
    data: { agentReadThroughSequence: top.sequence },
  });
  await db.conversationMember.update({
    where: { id: me.id },
    data: { readThroughSequence: sequence },
  });
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  await db.$disconnect();
});

/** Opens the "N seen" list of one own message and returns the page's text. */
async function openSeenBy(messageId: string, body: string, phone: boolean) {
  const row = `[data-message-id="${messageId}"]`;
  // The thread's replies also preview under the root in the stream: wait for the row itself.
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(row)}) !== null`);
  if (phone) {
    await evaluate(
      `(() => { const els = [...document.querySelectorAll(${JSON.stringify(`${row} p, ${row} span`)})].filter((e) => e.textContent.trim() === ${JSON.stringify(body)}); els[els.length - 1].click(); return true; })()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"]')?.innerText.includes("Agent didn't get this") === true`,
    );
    await evaluate(
      `(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes("Agent didn't get this")).click(); return true; })()`,
    );
  } else {
    await browser("hover", row);
    await browser("click", `${row} [aria-label="More"]`);
    await browser("wait", "--fn", `document.body.innerText.includes("Agent didn't get this")`);
    await evaluate(
      `(() => { const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes("Agent didn't get this")); item.focus(); item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); return true; })()`,
    );
  }
  await browser("wait", "--fn", `document.body.innerText.includes("missed this")`);
  return evaluate<string>(`document.body.innerText`);
}

for (const width of [1440, 390])
  test(`${width}px: the seen-by list says which Agents a message missed and why`, async () => {
    const phone = width < 1024;
    await browser("set", "viewport", String(width), "900");
    await browser("open", `${origin}/en/w/${workspaceSlug}/channel/${channelId}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.innerText.includes("E2E own top-level message")`,
    );
    const top = await openSeenBy(topId, "E2E own top-level message", phone);
    expect(top).toContain("1 seen");
    expect(top).toContain("Reader Agent");
    expect(top).toContain("Muted Agent\nMuted the channel, missed this");
    expect(top).not.toContain("Unfollowed the thread, missed this");

    await browser(
      "open",
      `${origin}/en/w/${workspaceSlug}/channel/${channelId}?threadRootId=${rootId}`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.innerText.includes("E2E own thread reply")`,
    );
    const reply = await openSeenBy(replyId, "E2E own thread reply", phone);
    expect(reply).toContain("Nobody viewed");
    expect(reply).toContain("Unfollower Agent\nUnfollowed the thread, missed this");
    expect(reply).not.toContain("Muted the channel, missed this");
  }, 120_000);
