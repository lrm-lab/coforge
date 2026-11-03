import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { saveUserMessage } from "#src/server/conversations/saved-messages.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A private channel named outside its own page (task #375): search, Saved, Activity, the Tasks
 * page, an Agent's reminders and the strip under a message whose mention did not reach someone.
 * Each names the private `vault` without `#` and the public `plaza` with it, and puts the lock
 * before the private name (the Activity row, the reminder and the mention strip lacked it).
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`, a seeded
 * database), `agent-browser` and local PostgreSQL. Everything it writes lives in a Workspace of its
 * own that it deletes afterwards. Screenshots are written under `.amp/e2e/private-channel-labels/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/private-channel-labels");

test("a private channel goes without `#` wherever another page names it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `private-labels-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-private-labels-${suffix}`;
  const workspacePath = `/en/w/${slug}`;
  const token = `label${suffix}`;
  const vaultName = `vault-${suffix}`;
  const plazaName = `plaza-${suffix}`;
  const [ada, grace] = await Promise.all(
    ["Ada", "Grace"].map((who) =>
      db.user.create({
        data: {
          username: `e2e-label-${who.toLowerCase()}-${suffix}`,
          displayName: `${who} ${suffix}`,
        },
      }),
    ),
  );
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E private labels",
    userId: DEV_BROWSER_USER.id,
  });
  const machineId = `e2e-label-${suffix}`;
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  const text = `document.body.textContent`;
  /** The page names the private channel bare and never as `#vault`. */
  const namesVaultBare = `${text}.includes("${vaultName}") && !${text}.includes("#${vaultName}")`;
  /** Outside the sidebar, the private name follows its lock. */
  const vaultLocked = `[...document.querySelectorAll('[role="img"][aria-label="Private"]')].some((lock) => !lock.closest("[data-sidebar]") && lock.nextElementSibling?.textContent === "${vaultName}")`;
  const both = async (shot: string) => {
    await browser("screenshot", join(artifacts, shot));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, shot.replace(".png", "-dark.png")));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  /** \`locked\`: the page names the channel with its lock; the Tasks board names it in a card's
   * text line, bare. */
  const shoot = async (path: string, ready: string, shot: string, locked = true) => {
    await browser("open", `${origin}${workspacePath}${path}`);
    await waitFor(`${pageHydrated} && ${ready}`);
    await browser("wait", "300");
    await both(shot);
    expect(await evaluate(namesVaultBare)).toBe(true);
    if (locked) expect(await evaluate(vaultLocked)).toBe(true);
  };
  try {
    for (const peer of [ada!, grace!])
      await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: peer.id } });
    /** A channel holding the dev user's message with Ada's unread reply in its followed thread,
     * and a Task. */
    const channel = async (name: string, visibility: "public" | "private") => {
      const created = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: name,
          visibility,
          members: {
            create: [
              { userId: DEV_BROWSER_USER.id },
              { userId: ada!.id },
              ...(visibility === "public" ? [{ userId: grace!.id }] : []),
            ],
          },
        },
        include: { members: true },
      });
      const memberOf = (userId: string) => created.members.find((row) => row.userId === userId)!;
      const mine = memberOf(DEV_BROWSER_USER.id);
      const root = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: created.id,
          senderMemberId: mine.id,
          sequence: 1,
          body: `${token} plans for ${name}`,
        },
      });
      await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: created.id,
          senderMemberId: memberOf(ada!.id).id,
          sequence: 2,
          threadRootId: root.id,
          body: `${token} a reply in ${name}`,
        },
      });
      await db.threadFollow.create({
        data: {
          memberId: mine.id,
          rootMessageId: root.id,
          conversationId: created.id,
          workspaceId: workspace.id,
        },
      });
      const work = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: created.id,
          senderMemberId: mine.id,
          sequence: 3,
          body: `Ship ${name}`,
        },
      });
      await db.task.create({
        data: {
          id: work.id,
          messageId: work.id,
          conversationId: created.id,
          workspaceId: workspace.id,
          number: 1,
          title: `Ship ${name}`,
          creatorMemberId: mine.id,
        },
      });
      await saveUserMessage(db, {
        workspaceId: workspace.id,
        conversationId: created.id,
        userId: DEV_BROWSER_USER.id,
        messageId: root.id,
      });
      return { id: created.id, root };
    };
    const vault = await channel(vaultName, "private");
    await channel(plazaName, "public");

    // An Agent of the dev user's with a reminder anchored in the private channel.
    const computer = await db.computer.create({
      data: { ownerId: DEV_BROWSER_USER.id, machineId, name: "label-mac" },
    });
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: computer.id },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: DEV_BROWSER_USER.id,
        computerId: computer.id,
        name: `label-keeper-${suffix}`,
        displayName: "Keeper",
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "e2e-model",
          modelProvider: "e2e-provider",
          reasoning: "balanced",
        },
      },
    });
    await db.reminder.create({
      data: {
        workspaceId: workspace.id,
        ownerAgentId: agent.id,
        computerId: computer.id,
        title: "Check the vault",
        target: "self",
        messageId: vault.root.id,
        fireAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    await shoot(
      `/search?q=${token}`,
      `${text}.includes("${plazaName}") && ${text}.includes("${vaultName}")`,
      "1-search.png",
    );
    await shoot(`/saved`, `${text}.includes("#${plazaName}")`, "2-saved.png");
    await shoot(`/activity`, `${text}.includes("#${plazaName}")`, "3-activity.png");
    await shoot(`/tasks`, `${text}.includes("#${plazaName}")`, "4-tasks.png", false);
    await shoot(
      `/agent/${agent.id}?agentTab=reminders`,
      `${text}.includes("Check the vault")`,
      "5-reminders.png",
    );

    // Mentioning Grace, who is not in the private channel, leaves the strip under the message.
    await browser("open", `${origin}${workspacePath}/channel/${vault.id}`);
    await waitFor(`${pageHydrated} && Boolean(document.querySelector("textarea"))`);
    await browser("fill", "textarea", `@${grace!.username} have a look`);
    await browser("press", "Escape");
    await browser("press", "Enter");
    await waitFor(`${text}.includes("was not notified")`);
    await browser("wait", "300");
    await both("6-mention-strip.png");
    expect(await evaluate(namesVaultBare)).toBe(true);
    expect(await evaluate(vaultLocked)).toBe(true);
  } catch (failure) {
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await db.reminder.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.message.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.computer.deleteMany({ where: { machineId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [ada!.id, grace!.id] } } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
