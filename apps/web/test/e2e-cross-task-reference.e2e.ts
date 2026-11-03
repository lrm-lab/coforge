import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Another conversation's Task in a message (task #456, the web part of task #437): a channel's
 * Task reads as its badge under the channel's current name (`#name:#N`), a direct message's under
 * the other side from the reader's seat (`dm:@peer:#N`), each with its title as the tooltip and a
 * link that opens it there. A private channel's Task the reader cannot see stays the words the
 * sender wrote. A change to a referenced Task repaints its badge live, from any conversation.
 *
 * The write flag (`task-ref-tokens`) is off, so the message is seeded with its stored tokens. Opt-in
 * like the other browser E2Es: real local Web, `agent-browser`, and Centrifugo behind a same-origin
 * proxy (`COFORGE_E2E_CENTRIFUGO_URL`). Screenshots, light, dark and phone, are written under
 * `.amp/e2e/cross-task-reference/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/cross-task-reference");

test("another conversation's Task reads as its live badge, or as the words for a reader who cannot see it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `cross-task-${process.pid}`);
  const centrifugo = createCentrifugoServerApi();
  const live = new TaskBoard(db, {
    realtime: new CentrifugoConversationRealtime(centrifugo),
    publisher: centrifugo,
  });
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  const channel = (name: string, visibility = "public") =>
    db.conversation.create({
      data: {
        workspaceId,
        channelName: name,
        description: "",
        visibility,
        members: { create: { userId: DEV_BROWSER_USER.id } },
      },
    });
  // The channel was renamed after the message named it: the badge reads its current name.
  const launch = await channel(`e2e-xref-launch-${tail}`);
  const secret = await channel(`e2e-xref-secret-${tail}`, "private");
  const here = await channel(`e2e-xref-${tail}`);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-xref-agent-${tail}`,
      displayName: `Xref Agent ${tail}`,
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
  const { conversationId: directId } = await new DirectConversations(db).open(
    workspaceId,
    DEV_BROWSER_USER.id,
    { agentId: agent.id },
  );
  const create = async (conversationId: string, title: string) =>
    (
      await live.execute(as, {
        idempotencyKey: crypto.randomUUID(),
        conversationId,
        operation: "create",
        title,
      } as Parameters<TaskBoard["execute"]>[1])
    ).tasks[0]!.number;
  try {
    const launchTask = await create(launch.id, `Ship the launch page ${tail}`);
    const secretTask = await create(secret.id, `Secret plan ${tail}`);
    const directTask = await create(directId, `Draft the release notes ${tail}`);
    const hereTask = await create(here.id, `Local follow-up ${tail}`);
    // The viewer leaves the private channel: its Task is no longer theirs to see.
    await db.conversationMember.updateMany({
      where: { conversationId: secret.id, userId: DEV_BROWSER_USER.id },
      data: { leftAt: new Date() },
    });
    const renamed = `e2e-xref-site-${tail}`;
    await db.conversation.update({ where: { id: launch.id }, data: { channelName: renamed } });
    // The Agent wrote it, so its DM token names the viewer; the viewer reads the Agent instead.
    const agentMember = await db.conversationMember.create({
      data: { conversationId: here.id, workspaceId, agentId: agent.id },
    });
    const seeded = await db.message.create({
      data: {
        conversationId: here.id,
        workspaceId,
        senderMemberId: agentMember.id,
        // After the message the channel's own Task was made from.
        sequence:
          ((
            await db.message.findFirst({
              where: { conversationId: here.id },
              orderBy: { sequence: "desc" },
              select: { sequence: true },
            })
          )?.sequence ?? 0) + 1,
        body:
          `Status: <@task:c:${launch.id}:${launch.channelName}:${launchTask}> is next, ` +
          `<@task:c:${secret.id}:${secret.channelName}:${secretTask}> waits, and ` +
          `<@task:d:${directId}:${viewer.username}:${directTask}> is mine, ` +
          `<@task:c:${here.id}:${here.channelName}:${hereTask}> is here.`,
      },
    });

    const launchLabel = `#${renamed}:#${launchTask}`;
    const directLabel = `dm:@${agent.name}:#${directTask}`;
    const linkTo = (label: string) =>
      `[...document.querySelectorAll(".message-markdown a")].find((el) => el.textContent === ${JSON.stringify(label)})`;
    const settled = () =>
      browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${linkTo(launchLabel)} != null && ${linkTo(directLabel)} != null`,
    );

    // The channel's Task: current name, title and status in its name, a link to it there.
    expect(await evaluate<string>(`${linkTo(launchLabel)}.getAttribute("aria-label")`)).toBe(
      `${launchLabel}, Ship the launch page ${tail}, To do`,
    );
    expect(await evaluate<string>(`${linkTo(launchLabel)}.getAttribute("href")`)).toEndWith(
      `/channel/${launch.id}?task=${launchTask}`,
    );
    // The direct message's: the other side from the viewer's seat.
    expect(await evaluate<string>(`${linkTo(directLabel)}.getAttribute("href")`)).toEndWith(
      `/dm/${directId}?task=${directTask}`,
    );
    // The private channel's: the words the sender wrote, nothing to open, no title.
    const body = await evaluate<string>(
      `document.querySelector('[data-message-id="${seeded.id}"] .message-markdown').textContent`,
    );
    expect(body).toContain(`#${secret.channelName}:#${secretTask} waits`);
    expect(body).not.toContain(`Secret plan`);
    expect(
      await evaluate<number>(
        `[...document.querySelectorAll(".message-markdown a")].filter((el) => el.textContent.includes("secret")).length`,
      ),
    ).toBe(0);

    // A reference that names the open channel is its own Task's badge, which opens in place.
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll(".message-markdown [data-task-status]")].some((el) => el.tagName === "SPAN" && el.textContent === "#${hereTask}")`,
      ),
    ).toBe(true);

    // The title is the badge's tooltip.
    await browser("click", "textarea[data-composer]");
    await evaluate(`${linkTo(launchLabel)}.setAttribute("data-e2e-launch", "") ?? true`);
    await browser("hover", "[data-e2e-launch]");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[role="tooltip"]')].some((el) => el.textContent.includes("Ship the launch page"))`,
    );
    await browser("screenshot", join(artifacts, "badges.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, "badges-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await settled();

    // A change to the Task, announced in its own channel, repaints the badge here.
    await live.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: launch.id,
      operation: "claim",
      numbers: [launchTask],
    } as Parameters<TaskBoard["execute"]>[1]);
    await browser(
      "wait",
      "--fn",
      `${linkTo(launchLabel)}?.getAttribute("data-task-status") === "in_progress"`,
    );

    // The badge opens the Task in its channel.
    await browser("click", "[data-e2e-launch]");
    await browser(
      "wait",
      "--fn",
      `location.pathname.endsWith("/channel/${launch.id}") && [...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes("Ship the launch page ${tail}"))`,
    );

    // Phone.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${linkTo(launchLabel)} != null`);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.conversation
      .deleteMany({ where: { id: { in: [launch.id, secret.id, here.id, directId] } } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
});
