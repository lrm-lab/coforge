import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A private channel's entry in a real browser (task #302): the Workspace owner starts a channel
 * with Make private on, and it opens with a lock where a public one shows `#`; its settings turn it
 * public and back, each confirmed by title and button alone, and the page follows.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`, a seeded
 * database), `agent-browser` and local PostgreSQL. Everything it writes lives in a Workspace of its
 * own that it deletes afterwards. Screenshots are written under `.amp/e2e/private-channel-entry/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/private-channel-entry");

test("a channel started private shows its lock, and its settings switch it public and back", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `private-channel-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-private-channel-${suffix}`;
  const workspacePath = `/en/w/${slug}`;
  const name = `vault-${suffix}`;
  const peers = await Promise.all(
    ["Ada", "Grace"].map((who) =>
      db.user.create({
        data: {
          username: `e2e-private-${who.toLowerCase()}-${suffix}`,
          displayName: `${who} ${suffix}`,
        },
      }),
    ),
  );
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E private channel",
    userId: DEV_BROWSER_USER.id,
  });
  const dialog = `document.querySelector('[role="dialog"]')`;
  // The channel's title: the page has other headings (the list's).
  const titles = `[...document.querySelectorAll("h1")]`;
  const lockedTitle = `${titles}.some((title) => Boolean(title.querySelector('svg[aria-label="Private"]')) && title.textContent.includes("${name}"))`;
  const visibility = async () =>
    (
      await db.conversation.findFirstOrThrow({
        where: { workspaceId: workspace.id, channelName: name },
        select: { visibility: true },
      })
    ).visibility;
  // A switch or checkbox is a hidden input inside its label: pressed through it, as a reader's
  // click on the label does.
  const press = (selector: string) =>
    evaluate(`document.querySelector('${selector}').click() ?? true`);
  const pressButton = async (label: string) => {
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "${label}").setAttribute("data-e2e-press", "") ?? true`,
    );
    await browser("click", "[data-e2e-press]");
    await evaluate(
      `document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press") ?? true`,
    );
  };
  try {
    for (const peer of peers)
      await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: peer.id } });
    const plaza = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `plaza-${suffix}`,
        members: {
          create: [DEV_BROWSER_USER.id, ...peers.map((peer) => peer.id)].map((userId) => ({
            userId,
          })),
        },
      },
    });
    await mkdir(artifacts, { recursive: true });

    // 1. Started private: the dialog's switch, then the channel with its lock.
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${plaza.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && Boolean(document.querySelector('button[aria-label="New"]'))`,
    );
    await browser("click", 'button[aria-label="New"]');
    await browser(
      "wait",
      "--fn",
      `Boolean([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Create Channel")))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Create Channel")).setAttribute("data-e2e-item", "") ?? true`,
    );
    await browser("click", "[data-e2e-item]");
    await browser(
      "wait",
      "--fn",
      `Boolean(${dialog}?.querySelector('input[aria-label="Ada ${suffix}"]'))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="dialog"] input')].find((input) => input.labels?.[0]?.textContent.includes("Channel name")).setAttribute("data-e2e-name", "") ?? true`,
    );
    await browser("fill", "[data-e2e-name]", name);
    for (const peer of peers) await press(`input[aria-label="${peer.displayName}"]`);
    await press('[role="dialog"] input[role="switch"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] input[role="switch"]').checked`,
    );
    // The switch's knob slides over; the shot waits for it to land.
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "1-create-private.png"));
    await pressButton("Finish");
    await browser("wait", "--fn", `${pageHydrated} && ${lockedTitle}`);
    expect(await visibility()).toBe("private");
    await browser("screenshot", join(artifacts, "2-private-channel.png"));

    // 2. Its settings make it public, once confirmed; the `#` is back.
    await browser("click", 'button[aria-label="Channel Details and Settings"]');
    await browser(
      "wait",
      "--fn",
      `Boolean([...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Change to Public Channel"))`,
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Change to Public Channel").scrollIntoView({ block: "center" }) ?? true`,
    );
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "3-settings-private.png"));
    await pressButton("Change to Public Channel");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[role="dialog"]')].some((open) => open.textContent.includes("Change ${name} to a public channel?"))`,
    );
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "4-confirm-public.png"));
    await pressButton("Change to Public");
    await browser(
      "wait",
      "--fn",
      `${titles}.some((title) => title.textContent.trim() === "#${name}")`,
    );
    expect(await visibility()).toBe("public");

    // 3. And private again.
    await browser("click", 'button[aria-label="Channel Details and Settings"]');
    await browser(
      "wait",
      "--fn",
      `Boolean([...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Change to Private Channel"))`,
    );
    await pressButton("Change to Private Channel");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[role="dialog"]')].some((open) => open.textContent.includes("Change #${name} to a private channel?"))`,
    );
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "5-confirm-private.png"));
    await pressButton("Change to Private");
    await browser("wait", "--fn", lockedTitle);
    expect(await visibility()).toBe("private");

    // 4. On a phone: the list and the channel, each with the lock.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes("${name}")`,
    );
    await browser("screenshot", join(artifacts, "6-phone-list.png"));
    const vault = await db.conversation.findFirstOrThrow({
      where: { workspaceId: workspace.id, channelName: name },
    });
    await browser("open", `${origin}${workspacePath}/channel/${vault.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${lockedTitle}`);
    await browser("screenshot", join(artifacts, "7-phone-private-channel.png"));
    await browser("click", 'button[aria-label="Channel Details and Settings"]');
    await browser(
      "wait",
      "--fn",
      `Boolean([...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Change to Public Channel"))`,
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Change to Public Channel").scrollIntoView({ block: "center" }) ?? true`,
    );
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "8-phone-settings.png"));
    await browser("press", "Escape");

    // The phone's sheet for a new channel has the switch too.
    await browser("open", `${origin}${workspacePath}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && Boolean(document.querySelector('button[aria-label="New"]'))`,
    );
    await browser("click", 'button[aria-label="New"]');
    await browser(
      "wait",
      "--fn",
      `Boolean([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Create Channel")))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Create Channel")).setAttribute("data-e2e-sheet", "") ?? true`,
    );
    await browser("click", "[data-e2e-sheet]");
    await browser("wait", "--fn", `Boolean(${dialog}?.querySelector('input[role="switch"]'))`);
    await press('[role="dialog"] input[role="switch"]');
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "9-phone-create-private.png"));
  } catch (failure) {
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await db.message.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user
      .deleteMany({ where: { id: { in: peers.map((peer) => peer.id) } } })
      .catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
