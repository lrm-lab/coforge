import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  productionArtifactShares,
  productionArtifacts,
} from "#src/server/artifacts/artifact-composition.server";
import { postUserMessage } from "#src/server/conversations/user-message-post.server";
import { assertUserMayPost } from "#src/server/conversations/user-post-access.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { quietCentrifugo } from "./helpers/fake-centrifugo";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Sending an artifact into a conversation (artifacts task #2): from its page's ⋯ menu, "Send to…"
 * opens Forward's picker with the artifact's card as what arrives; the channel picked gets a
 * message with the note above the link, which reads there as the card. In the same channel, a
 * link to an artifact the viewer may not open shows only that they have no access, and one to a
 * deleted artifact only that it was deleted. On a phone the picker is two steps.
 *
 * Opt-in like the other browser E2Es: real local Web with the `artifacts` experiment switched on
 * per Workspace. Screenshots go under `.artifacts/e2e/artifact-send/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/artifact-send");

test("an artifact sent to a channel arrives as its card; shut and deleted ones say so", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `artifact-send-${process.pid}`,
  );
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    // Other e2es leave the dev user in Workspaces of their own; the seed made the first one.
    orderBy: { workspace: { createdAt: "asc" } },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-send-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const noor = await db.user.create({
    data: { username: `noor-send-${tail}`, displayName: "Noor Haddad" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: noor.id, role: "member" } });
  // Where the artifact lives, and where it is sent: the viewer is in both.
  const home = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-send-home-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const target = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-send-to-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: noor.id }, { agentId: agent.id }],
      },
    },
  });
  // Noor's private channel, which the viewer is not in.
  const closed = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-send-closed-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: noor.id }, { agentId: agent.id }] },
    },
  });
  const quiet = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-send-quiet-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const shoot = async (shot: string) => {
    await browser(
      "wait",
      "--fn",
      `document.getAnimations().every((a) => a.playState !== "running")`,
    );
    await browser("screenshot", join(artifacts, `${shot}.png`));
  };
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const targetRow = (label: string) => `label:has(input[aria-label=${JSON.stringify(label)}])`;
  const pick = async (label: string) => {
    await browser(
      "fill",
      'input[placeholder="Search channels, people or Agents"]',
      label.replace(/^#/, ""),
    );
    await waitFor(`document.querySelector(${JSON.stringify(targetRow(label))}) !== null`);
    // The row may sit below the list's fold until the search narrows it; bring it into view.
    await evaluate(
      `(document.querySelector(${JSON.stringify(targetRow(label))}).scrollIntoView({ block: "nearest" }), true)`,
    );
    await browser("click", targetRow(label));
  };
  const openSend = async () => {
    await waitFor(`${pageHydrated} && document.querySelector("main .ProseMirror") != null`, 60_000);
    await press(`document.querySelector('main header button[aria-label="More actions"]')`);
    await waitFor(`document.querySelector('[role="menuitem"]') !== null`);
    await press(
      `[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim() === "Send to…")`,
    );
    await waitFor(
      `document.querySelector('[role="dialog"] input[placeholder="Search channels, people or Agents"]') !== null`,
    );
  };
  // Noor's share: as a person, under her own send, as the web's does.
  const shareAsNoor = (artifactId: string) =>
    productionArtifactShares(db, async () => true).share({
      workspaceId,
      actor: { userId: noor.id },
      artifactId,
      targets: [target.id],
      requestId: crypto.randomUUID(),
      unseen: "send",
      send: ({ target: conversationId, idempotencyKey, body }) =>
        postUserMessage(
          {
            db,
            idempotency: { execute: (_scope, persist) => persist() },
            publisher: quietCentrifugo(),
          },
          { workspaceId, userId: noor.id, conversationId, idempotencyKey, body },
        ),
      mayPost: (conversationId) => assertUserMayPost(db, workspaceId, noor.id, conversationId),
    });
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    const bot = agentWrites(services, workspaceId, agent.id);
    const plan = await bot.create({
      conversationId: home.id,
      title: "Launch plan",
      files: {
        "plan.md": `Ship the beta to the first ten teams, then widen it.\nOwners and dates below (run ${tail}).`,
      },
    });

    // From the ⋯ menu, Send to… opens the picker with the card; the note goes above the link.
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/artifacts/${plan.id}`);
    await openSend();
    // What arrives is named under the list, read once the dialog is up.
    await waitFor(
      `document.querySelector('[role="dialog"] button[aria-expanded]')?.textContent.includes("Launch plan")`,
    );
    await pick(`#e2e-send-to-${tail}`);
    await browser("fill", '[role="dialog"] textarea', "For Thursday's review");
    await shoot("1-send-dialog");
    await press(`document.querySelector('[role="dialog"] button[aria-label="Send to 1"]')`);
    await waitFor(`document.querySelector('[role="dialog"]') === null`);
    const sent = await db.message.findFirstOrThrow({
      where: { conversationId: target.id, body: { contains: `/artifacts/${plan.id}` } },
      select: { body: true, sender: { select: { userId: true } } },
    });
    expect(sent.body.startsWith("For Thursday's review\n\n")).toBe(true);
    expect(sent.sender?.userId).toBe(DEV_BROWSER_USER.id);

    // Noor shares one the viewer may not open, and one the viewer may, which is then deleted.
    const secret = await bot.create({
      conversationId: closed.id,
      title: "Salary bands",
      files: { "bands.md": `Private (run ${tail}).` },
    });
    const gone = await bot.create({
      conversationId: target.id,
      title: "Old draft",
      files: { "draft.md": `Draft (run ${tail}).` },
    });
    expect((await shareAsNoor(secret.id)).outcome).toBe("success");
    expect((await shareAsNoor(gone.id)).outcome).toBe("success");
    await db.artifact.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${target.id}`);
    await waitFor(`document.body.textContent.includes("For Thursday's review")`, 60_000);
    await waitFor(
      `document.body.textContent.includes("You don't have access to this artifact") && document.body.textContent.includes("This artifact was deleted")`,
    );
    expect(await evaluate<boolean>(`document.body.textContent.includes("Salary bands")`)).toBe(
      false,
    );
    expect(await evaluate<boolean>(`document.body.textContent.includes("Old draft")`)).toBe(false);
    // Their links, alone on their lines, read as nothing beside the cards that say so.
    for (const id of [secret.id, gone.id])
      expect(
        await evaluate<boolean>(
          `[...document.querySelectorAll("li[data-message-id]")].some((row) => row.textContent.includes("/artifacts/${id}"))`,
        ),
      ).toBe(false);
    await waitFor(`document.querySelector('article[aria-label*="Launch plan"] a') !== null`);
    await shoot("2-channel-cards");

    // From a private home, to a channel with a recipient who cannot read it: held, nothing is
    // posted, and the three ways on are named.
    const notes = await bot.create({
      conversationId: quiet.id,
      title: "Board notes",
      files: { "notes.md": `Notes (run ${tail}).` },
    });
    const posted = (id: string) =>
      db.message.count({ where: { conversationId: target.id, body: { contains: id } } });
    const sendFromHeld = async (id: string, way: string) => {
      await browser("set", "viewport", "1280", "860");
      await browser("open", `${origin}/en/w/${workspace.slug}/artifacts/${id}`);
      await openSend();
      await pick(`#e2e-send-to-${tail}`);
      await press(`document.querySelector('[role="dialog"] button[aria-label="Send to 1"]')`);
      await waitFor(
        `document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes("can't see this artifact")`,
      );
      expect(await posted(id)).toBe(0);
      const ways = await evaluate<string[]>(
        `[...document.querySelectorAll('[role="dialog"] [role="alert"] ~ div button')].map((b) => b.textContent.trim())`,
      );
      expect(ways).toContain("Make it visible to the Workspace");
      expect(ways).toContain("Send anyway");
      await shoot(`3-held-${way}`);
      await press(byLabel(way));
      await waitFor(`document.querySelector('[role="dialog"]') === null`);
      expect(await posted(id)).toBe(1);
    };
    const byLabel = (label: string) =>
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
    await sendFromHeld(notes.id, "Send anyway");
    expect((await db.artifact.findUniqueOrThrow({ where: { id: notes.id } })).access).not.toBe(
      "workspace",
    );
    const roster = await bot.create({
      conversationId: quiet.id,
      title: "Roster",
      files: { "roster.md": `Roster (run ${tail}).` },
    });
    await sendFromHeld(roster.id, "Make it visible to the Workspace");
    expect((await db.artifact.findUniqueOrThrow({ where: { id: roster.id } })).access).toBe(
      "workspace",
    );

    // A phone: one sheet, the destinations over the note and the send button.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/artifacts/${plan.id}`);
    await openSend();
    await pick(`#e2e-send-home-${tail}`);
    await waitFor(`document.querySelector('[role="dialog"] textarea')?.offsetParent != null`);
    await shoot("4-phone-sheet");
  } finally {
    await browser("close").catch(() => {});
    await experiments.write(workspaceId, "artifacts", before);
    await db.conversation.deleteMany({
      where: { id: { in: [home.id, target.id, closed.id, quiet.id] } },
    });
    await db.agent.deleteMany({ where: { id: agent.id } });
    await db.workspaceMembership.deleteMany({ where: { userId: noor.id } });
    await db.user.deleteMany({ where: { id: noor.id } });
    await db.$disconnect();
  }
}, 180_000);
