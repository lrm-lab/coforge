import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An address from the old search page (`/search?open=channel:<id>&msg=<id>`), which previewed a
 * conversation beside its results, still opens that conversation at the message now that search is
 * a dialog: links people saved or shared, and links in notifications, keep working. A conversation
 * the viewer cannot open shows nothing of it, and a message since deleted still opens its
 * conversation. Opt-in like the other browser E2Es; the channels are seeded per run and removed.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("an old search address opens its conversation at the message", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `search-legacy-${process.pid}`,
  );
  const suffix = `${process.pid}-${Date.now()}`;
  const created: string[] = [];
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const owner = await db.user.create({
      data: { username: `e2e-legacy-owner-${suffix}`, displayName: "Legacy Owner" },
    });
    await db.workspaceMembership.create({ data: { workspaceId, userId: owner.id } });
    const seed = async (name: string, visibility: "public" | "private", viewerIn: boolean) => {
      const channel = await db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
          visibility,
          description: "",
          members: {
            create: [
              { userId: owner.id, channelRole: "admin" },
              ...(viewerIn ? [{ userId: DEV_BROWSER_USER.id }] : []),
            ],
          },
        },
        include: { members: true },
      });
      created.push(channel.id);
      const sender = channel.members.find((member) => member.userId === owner.id)!;
      const messages = [];
      for (let sequence = 1; sequence <= 3; sequence++)
        messages.push(
          await db.message.create({
            data: {
              workspaceId,
              conversationId: channel.id,
              sequence,
              senderMemberId: sender.id,
              body: `Legacy ${name} message ${sequence}`,
            },
          }),
        );
      return { channel, messages };
    };
    const open = await seed(`e2e-legacy-${suffix}`, "public", true);
    const locked = await seed(`e2e-legacy-locked-${suffix}`, "private", false);
    const legacy = (channelId: string, messageId: string) =>
      `${origin}/en/w/${workspace.slug}/search?open=channel:${channelId}&msg=${messageId}`;
    const address = `location.pathname + location.search`;
    const shown = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;

    // The old address lands on the conversation, at the message it named.
    await browser("set", "viewport", "1440", "900");
    await browser("open", legacy(open.channel.id, open.messages[1]!.id));
    await waitFor(`${pageHydrated} && location.pathname.endsWith("/channel/${open.channel.id}")`);
    expect(await evaluate<string>(address)).toBe(
      `/en/w/${workspace.slug}/channel/${open.channel.id}?message=${open.messages[1]!.id}`,
    );
    await waitFor(`document.getElementById("message-${open.messages[1]!.id}") !== null`);
    expect(await evaluate<boolean>(`document.querySelector('[role="dialog"]') === null`)).toBe(
      true,
    );

    // A private channel the viewer is not in: its page, with nothing of the channel on it.
    await browser("open", legacy(locked.channel.id, locked.messages[0]!.id));
    await waitFor(`${pageHydrated} && location.pathname.endsWith("/channel/${locked.channel.id}")`);
    await Bun.sleep(1500);
    expect(await evaluate<boolean>(shown(locked.channel.channelName!))).toBe(false);
    expect(await evaluate<boolean>(shown(locked.messages[0]!.body))).toBe(false);

    // A message deleted since: the conversation still opens, with its other messages.
    const gone = open.messages[2]!;
    await db.message.delete({ where: { id: gone.id } });
    await browser("open", legacy(open.channel.id, gone.id));
    await waitFor(`${pageHydrated} && location.pathname.endsWith("/channel/${open.channel.id}")`);
    await waitFor(shown(open.messages[0]!.body));
    expect(await evaluate<boolean>(shown(gone.body))).toBe(false);

    // Search with no conversation named is still the dialog over the Workspace.
    await browser("open", `${origin}/en/w/${workspace.slug}/search?q=legacy`);
    await waitFor(`${pageHydrated} && document.querySelector('[role="dialog"] input') !== null`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    await db.workspaceMembership
      .deleteMany({ where: { user: { username: { startsWith: `e2e-legacy-owner-${suffix}` } } } })
      .catch(() => undefined);
    await db.user
      .deleteMany({ where: { username: `e2e-legacy-owner-${suffix}` } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
