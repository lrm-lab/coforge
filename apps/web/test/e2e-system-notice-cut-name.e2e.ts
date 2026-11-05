import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #561 (Frank, 11-05, on his phone): "@qa-test-agent added @piresearch-3d-frontend to this
 * channel." is longer than a phone's notice line, which is cut to one. Each name in it is words of
 * the line, so the cut falls inside the name ("added <face> @p…"); drawn as one box, the name was
 * dropped whole and the line read "added …<face>".
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome as a phone. The
 * Agents, channel and notice are seeded per run and removed after it.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("a notice cut on a phone cuts inside a name, never drops it", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const runtimeConfig = {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const [actor, added] = await Promise.all(
    [`e2e-adder-${tail}`, `e2e-research-3d-frontend-${tail}`].map((name) =>
      db.agent.create({
        data: { workspaceId, name, displayName: name, ownerId: DEV_BROWSER_USER.id, runtimeConfig },
      }),
    ),
  );
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-notice-cut-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { agentId: actor!.id }, { agentId: added!.id }],
      },
    },
    include: { members: true },
  });
  const person = (agent: { id: string; name: string }) => ({
    memberId: channel.members.find((member) => member.agentId === agent.id)!.id,
    handle: agent.name,
    displayName: agent.name,
    kind: "agent" as const,
  });
  const notice = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      senderMemberId: null,
      sequence: 1,
      body: `@${actor!.name} added @${added!.name} to this channel.`,
    },
  });
  await db.systemMessage.create({
    data: {
      messageId: notice.id,
      conversationId: channel.id,
      workspaceId,
      kind: "channel.member_added",
      params: { actor: person(actor!), members: [person(added!)] },
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });

  const browser = await launchHeadlessChrome(chrome);
  try {
    const page = await browser.open(`${origin}/en/w/${workspace.slug}/channel/${channel.id}`, {
      phone: { width: 390, height: 844 },
    });
    const row = `document.querySelector('[data-message-id="${notice.id}"]')`;
    await until(
      () => page.evaluate<boolean>(`${row}?.querySelector("[data-avatar]") != null`),
      60_000,
    );
    const line = await page.evaluate<{
      cut: boolean;
      names: { name: string; display: string }[];
    }>(`(() => {
      const faces = [...${row}.querySelectorAll("[data-avatar]")];
      const trigger = faces[0].closest("button") ?? faces[0].parentElement.parentElement;
      return {
        cut: trigger.scrollWidth > trigger.clientWidth,
        names: faces.map((face) => ({
          name: face.parentElement.textContent,
          display: getComputedStyle(face.parentElement).display,
        })),
      };
    })()`);
    // The phone's line is too short for the sentence: it is cut.
    expect(line.cut).toBe(true);
    // Both names are words of that line, so its ellipsis can fall inside one.
    expect(line.names).toEqual([
      { name: `@${actor!.name}`, display: "inline" },
      { name: `@${added!.name}`, display: "inline" },
    ]);
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [actor!.id, added!.id] } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
