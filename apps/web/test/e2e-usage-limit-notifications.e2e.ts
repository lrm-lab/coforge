import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * The bell (task #641): an owner sees one card per Computer and provider, opening
 * the list marks them seen, Dismiss hides one, and a close on the owner's channel takes the card
 * away live; a member, who is not shown usage limits, still has the bell, empty. Seeds a Computer,
 * its Agents and the events, and removes them (and restores the owner's role) after the run.
 * Screenshots, light, dark and phone, are written under `.amp/e2e/usage-limit-notifications/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
const centrifugoApiKey = Bun.env.COFORGE_CENTRIFUGO_API_KEY;
if (!centrifugoOrigin || !centrifugoApiKey)
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL and COFORGE_CENTRIFUGO_API_KEY are required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/usage-limit-notifications");

test("usage-limit cards count, get seen, get dismissed and leave live", async () => {
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `usage-limit-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-limit-${suffix}`,
      name: `e2e-limit-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const agents = await Promise.all(
    ["a", "b", "c"].map((letter) =>
      db.agent.create({
        data: {
          workspaceId,
          computerId: computer.id,
          name: `e2e-limit-${letter}-${suffix}`,
          displayName: `Limit ${letter}`,
          ownerId: DEV_BROWSER_USER.id,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      }),
    ),
  );
  const [first, second, third] = agents as [
    (typeof agents)[number],
    (typeof agents)[number],
    (typeof agents)[number],
  ];
  const seed = (provider: string, resetsAt: Date | null, affected: typeof agents) =>
    db.usageLimitEvent.create({
      data: {
        workspaceId,
        computerId: computer.id,
        provider,
        resetsAt,
        agents: {
          create: affected.map((agent) => ({ agentId: agent.id, workspaceId })),
        },
      },
    });
  const claude = await seed("claude-code", new Date(Date.now() + 3 * 3_600_000), [first, second]);
  const codex = await seed("codex", null, [third]);

  const page = `${proxy.origin}/en/w/${workspace.slug}/members`;
  const dialog = `document.querySelector('[role="dialog"][aria-label="Notifications"]')`;
  const hasCards = (count: number) =>
    `(${dialog}?.querySelectorAll("li").length ?? -1) === ${count}`;
  const clickFirst = async (selector: string) => {
    await evaluate(`(() => {
      const match = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
        (el) => el.getBoundingClientRect().width > 0,
      );
      match.setAttribute("data-e2e", "target");
      return true;
    })()`);
    await browser("click", '[data-e2e="target"]');
    await evaluate(
      `document.querySelector('[data-e2e="target"]')?.removeAttribute("data-e2e") ?? true`,
    );
  };
  const bell = 'button[aria-label^="Notifications"]';
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300"); // Buttons ease between themes.
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await mkdir(artifacts, { recursive: true });

    // A phone: the bell in a tab home's header carries the unseen count, then opens a sheet.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/activity`);
    const phoneBell = `[...document.querySelectorAll(${JSON.stringify(bell)})].find((el) => el.getBoundingClientRect().width > 0)`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${phoneBell}?.getAttribute("aria-label") === "Notifications, 2 unread"`,
    );
    await shots("phone-bell");
    await clickFirst(bell);
    await browser("wait", "--fn", hasCards(2));
    await browser("wait", "400");
    await shots("phone-sheet");

    // Desktop, unseen: the count, then one card per provider with the merged Agent count.
    await db.usageLimitEventView.deleteMany({ where: { eventId: { in: [claude.id, codex.id] } } });
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    const visibleBell = `[...document.querySelectorAll(${JSON.stringify(bell)})].find((el) => el.getBoundingClientRect().width > 0)`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${visibleBell}?.getAttribute("aria-label") === "Notifications, 2 unread"`,
    );
    await clickFirst(bell);
    await browser("wait", "--fn", hasCards(2));
    await browser("wait", "400");
    await shots("desktop-two");
    const text = await evaluate<string>(`${dialog}.textContent`);
    expect(text).toContain("Claude Code reached its usage limit");
    expect(text).toContain("2 Agents on E2E Studio may pause. Usage should reset");
    expect(text).toContain("1 Agent on E2E Studio may pause until usage recovers.");

    // Closing the list marks what it showed seen.
    await browser("click", "h1");
    await browser("wait", "--fn", `${visibleBell}?.getAttribute("aria-label") === "Notifications"`);
    const seen = async () =>
      db.usageLimitEventView.count({
        where: { userId: DEV_BROWSER_USER.id, seenAt: { not: null } },
      });
    for (let tries = 0; (await seen()) < 2 && tries < 50; tries += 1) await Bun.sleep(100);
    expect(await seen()).toBe(2);

    // Dismiss hides the card for this person and stores it.
    await clickFirst(bell);
    await browser("wait", "--fn", hasCards(2));
    await evaluate(`(() => {
      [...${dialog}.querySelectorAll("li")].find((el) => el.textContent.includes("Codex")).querySelectorAll("button")[1].setAttribute("data-e2e", "dismiss");
      return true;
    })()`);
    await browser("click", '[data-e2e="dismiss"]');
    await browser("wait", "--fn", hasCards(1));
    const dismissed = async () =>
      db.usageLimitEventView.findUnique({
        where: { eventId_userId: { eventId: codex.id, userId: DEV_BROWSER_USER.id } },
      });
    for (let tries = 0; !(await dismissed())?.dismissedAt && tries < 50; tries += 1)
      await Bun.sleep(100);
    expect((await dismissed())?.dismissedAt).toBeInstanceOf(Date);
    await shots("desktop-one");

    // The event closes on the server: the open list loses the card with no reload.
    await db.usageLimitEvent.update({
      where: { id: claude.id },
      data: { status: "closed", closedAt: new Date(), closeReason: "recovered" },
    });
    const response = await fetch(`${centrifugoOrigin}/api/publish`, {
      method: "POST",
      headers: { "x-api-key": centrifugoApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        channel: userConversationChannel(DEV_BROWSER_USER.id),
        data: {
          type: REALTIME_EVENTS.usageLimitChanged,
          workspaceId,
          eventId: claude.id,
          status: "closed",
          closeReason: "recovered",
          affectedCount: 0,
          resetsAt: null,
        },
      }),
    });
    expect(response.ok).toBe(true);
    await browser("wait", "--fn", `${dialog}?.textContent.includes("No notifications") === true`);
    await browser("wait", "300");
    await shots("desktop-empty");
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.usageLimitEvent
      .deleteMany({ where: { id: { in: [claude.id, codex.id] } } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { computerId: computer.id } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

test("a member's bell is there and empty while a usage limit is open", async () => {
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser } = browserSession(browserPath, `usage-limit-member-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const membership = { userId: DEV_BROWSER_USER.id, workspaceId };
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-limit-member-${suffix}`,
      name: `e2e-limit-member-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const event = await db.usageLimitEvent.create({
    data: { workspaceId, computerId: computer.id, provider: "codex", resetsAt: null },
  });
  const bell = `[...document.querySelectorAll('button[aria-label^="Notifications"]')].find((el) => el.getBoundingClientRect().width > 0)`;
  try {
    // The same person as a member: usage limits are an owner's or admin's, so the bell is empty.
    await db.workspaceMembership.updateMany({ where: membership, data: { role: "member" } });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/members`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${bell}?.getAttribute("aria-label") === "Notifications"`,
    );
    await browser("eval", `${bell}.click()`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"][aria-label="Notifications"]')?.textContent.includes("No notifications") === true`,
    );
  } finally {
    await db.workspaceMembership
      .updateMany({ where: membership, data: { role: "owner" } })
      .catch(() => undefined);
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.usageLimitEvent.deleteMany({ where: { id: event.id } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
