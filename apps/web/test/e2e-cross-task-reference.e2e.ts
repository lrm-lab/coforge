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
 * Another conversation's Task in a message (task #456, the web part of task #437) reads as its
 * label: the status icon and the title, and nothing else. Its number and where it lives — the
 * channel under its current name, a direct message as the other side from the reader's seat — are
 * in its name and its peek, with the whole title; a press opens it there. A private channel's Task
 * the reader cannot see is "a Task you can't view", without its number, status or channel. A
 * change to a referenced Task repaints its label live, from any conversation.
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

test("another conversation's Task reads as its live label, or as a Task the reader can't view", async () => {
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

    // The same references as a person types them, which the body keeps while the server stores no
    // tokens for them (task #472): read from the words, `dm:@peer` never a mention of its own.
    const viewerMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: here.id, userId: DEV_BROWSER_USER.id },
    });
    const typed = await db.message.create({
      data: {
        conversationId: here.id,
        workspaceId,
        senderMemberId: viewerMember.id,
        sequence: seeded.sequence + 1,
        body:
          `Typed: #${renamed}:#${launchTask} then dm:@${agent.name}:#${directTask}, ` +
          `and #${secret.channelName}:#${secretTask} stays.`,
      },
    });
    await db.conversation.update({
      where: { id: here.id },
      data: { lastSequence: typed.sequence },
    });

    const launchTitle = `Ship the launch page ${tail}`;
    const label = (title: string) =>
      `[...document.querySelectorAll(".message-markdown [data-task-status]")].find((el) => el.textContent === ${JSON.stringify(title)})`;
    const chip = (title: string) => `${label(title)}?.closest("[role=button]")`;
    const settled = () =>
      browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${chip(launchTitle)} != null && ${chip(`Draft the release notes ${tail}`)} != null`,
    );

    // The channel's Task: its title on the label; status, number and current channel in its name.
    expect(await evaluate<string>(`${chip(launchTitle)}.getAttribute("aria-label")`)).toBe(
      `${launchTitle}, To do, #${launchTask} · #${renamed}`,
    );
    // The direct message's: the other side from the viewer's seat.
    expect(
      await evaluate<string>(
        `${chip(`Draft the release notes ${tail}`)}.getAttribute("aria-label")`,
      ),
    ).toEndWith(`#${directTask} · DM with @${agent.name}`);
    // The private channel's: said so, with nothing to open and nothing of the Task.
    const body = await evaluate<string>(
      `document.querySelector('[data-message-id="${seeded.id}"] .message-markdown').textContent`,
    );
    expect(body).toContain("Task you can't view waits");
    expect(body).not.toContain(`Secret plan`);
    expect(body).not.toContain(secret.channelName!);
    expect(body).not.toContain(`#${secretTask}`);
    // A reference that names the open channel is its own Task's label, which opens in place.
    expect(await evaluate<boolean>(`${chip(`Local follow-up ${tail}`)} != null`)).toBe(true);

    // The typed references: the channel's and the direct message's Tasks are labels, the private
    // channel's stays as written, and the Agent named in `dm:@…` is no mention.
    const typedBody = `document.querySelector('[data-message-id="${typed.id}"] .message-markdown')`;
    await browser(
      "wait",
      "--fn",
      `${typedBody}?.querySelectorAll("[data-task-status]").length === 2`,
    );
    expect(
      await evaluate<string[]>(
        `[...${typedBody}.querySelectorAll("[data-task-status]")].map((el) => el.textContent)`,
      ),
    ).toEqual([launchTitle, `Draft the release notes ${tail}`]);
    expect(await evaluate<string>(`${typedBody}.textContent`)).toContain(
      `#${secret.channelName}:#${secretTask} stays.`,
    );
    expect(
      await evaluate<number>(`${typedBody}.querySelectorAll("[data-mention-agent-id]").length`),
    ).toBe(0);

    // The peek from the keyboard (task #472): focus on the label opens it, the whole title and
    // where the Task lives.
    const peekShown = `[...document.querySelectorAll("p")].some((el) => el.textContent === "#${launchTask} · #${renamed}")`;
    await evaluate(`${chip(launchTitle)}.focus() ?? true`);
    await browser("press", "Shift+Tab");
    await browser("press", "Tab");
    await browser(
      "wait",
      "--fn",
      `document.activeElement === ${chip(launchTitle)} && ${peekShown}`,
    );
    await evaluate(`document.activeElement.blur() ?? true`);
    await browser("wait", "--fn", `!(${peekShown})`);
    // And on hover, once the page has seen a press.
    await browser("click", "textarea[data-composer]");
    await evaluate(`${chip(launchTitle)}.setAttribute("data-e2e-launch", "") ?? true`);
    await browser("hover", "[data-e2e-launch]");
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("p")].some((el) => el.textContent === "#${launchTask} · #${renamed}")`,
    );
    await browser("screenshot", join(artifacts, "labels.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, "labels-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await settled();

    // A change to the Task, announced in its own channel, repaints the label here.
    await live.execute(as, {
      idempotencyKey: crypto.randomUUID(),
      conversationId: launch.id,
      operation: "claim",
      numbers: [launchTask],
    } as Parameters<TaskBoard["execute"]>[1]);
    await browser(
      "wait",
      "--fn",
      `${label(launchTitle)}?.getAttribute("data-task-status") === "in_progress"`,
    );

    // The label opens the Task in its channel.
    await browser("click", "[data-e2e-launch]");
    await browser(
      "wait",
      "--fn",
      `location.pathname.endsWith("/channel/${launch.id}") && [...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes("Ship the launch page ${tail}"))`,
    );

    // Phone.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${chip(launchTitle)} != null`);
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
}, 180_000);
