import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A reference in message text stands out from the text around it: mentions, a channel and a link
 * are not the body's colour, and a mention of the viewer is a solid chip. Seeds an Agent and a
 * message and removes them after the run. Screenshots, light, dark and phone, are written under
 * `.amp/e2e/message-reference-color/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-reference-color");

test("mentions, channels and links keep their colour in message text", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `reference-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const member = await db.conversationMember.findFirstOrThrow({
    where: {
      userId: DEV_BROWSER_USER.id,
      leftAt: null,
      conversation: { workspaceId, channelName: { not: null }, archivedAt: null },
    },
    include: { conversation: { select: { id: true, channelName: true } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-ref-${suffix}`,
      displayName: `Reference Agent`,
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
  const newest = await db.message.findFirst({
    where: { conversationId: member.conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const id = randomUUID();
  await db.message.create({
    data: {
      id,
      conversationId: member.conversationId,
      workspaceId,
      senderMemberId: member.id,
      sequence: (newest?.sequence ?? 0) + 1,
      body: `Please check with <@agent:${agent.id}> and <@human:${DEV_BROWSER_USER.id}> in <@channel:${member.conversationId}:${member.conversation.channelName}>, the notes are [here](https://example.com/notes).`,
    },
  });
  const agentMember = await db.conversationMember.create({
    data: { workspaceId, conversationId: member.conversationId, agentId: agent.id },
  });
  const viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
  await db.messageMention.createMany({
    data: [
      {
        messageId: id,
        memberId: agentMember.id,
        conversationId: member.conversationId,
        workspaceId,
        kind: "agent",
        actorId: agent.id,
        handle: agent.name,
      },
      {
        messageId: id,
        memberId: member.id,
        conversationId: member.conversationId,
        workspaceId,
        kind: "user",
        actorId: viewer.id,
        handle: viewer.username ?? "dev",
      },
    ],
  });
  const colors = `(() => {
    const message = [...document.querySelectorAll(".message-markdown")].find((el) => el.textContent.includes("the notes are"));
    const read = (el) => { const style = getComputedStyle(el); return { color: style.color, background: style.backgroundColor }; };
    const chips = [...message.querySelectorAll(".message-markdown-mention")];
    return {
      text: read(message),
      agent: read(chips.find((el) => el.textContent.includes("Reference Agent"))),
      self: read(chips.find((el) => !el.textContent.includes("Reference Agent"))),
      channel: read(message.querySelector(".message-markdown-channel-reference")),
      link: read(message.querySelector("a[href^='https://example.com']")),
    };
  })()`;
  const ready = `${pageHydrated} && [...document.querySelectorAll(".message-markdown")].some((el) => el.textContent.includes("the notes are") && el.querySelector(".message-markdown-mention"))`;
  type Read = Record<"text" | "agent" | "self" | "channel" | "link", Record<string, string>>;
  const check = (read: Read) => {
    expect(read.agent.color).not.toBe(read.text.color);
    expect(read.agent.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(read.channel.color).toBe(read.agent.color);
    expect(read.link.color).toBe(read.agent.color);
    expect(read.self.background).not.toBe(read.agent.background);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    const url = `${origin}/en/w/${workspace.slug}/channel/${member.conversationId}`;
    await browser("set", "viewport", "1280", "860");
    await browser("open", url);
    await browser("wait", "--fn", ready);
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "desktop.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "200");
    await browser("screenshot", join(artifacts, "desktop-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    check(await evaluate<Read>(colors));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "200");
    await browser("screenshot", join(artifacts, "desktop-dark.png"));
    check(await evaluate<Read>(colors));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await browser("set", "viewport", "390", "844");
    await browser("open", url);
    await browser("wait", "--fn", ready);
    await browser("wait", "500");
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.message.deleteMany({ where: { id } }).catch(() => undefined);
    await db.conversationMember
      .deleteMany({ where: { id: agentMember.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
