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
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  animationsSettled,
  pageHydrated,
} from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";
import { nonTaskDialogs, taskDetailPanels } from "./helpers/task-detail-e2e";

const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/cross-task-reference");

test("another conversation's Task reads as its live label, or as a non-focusable lock badge when unauthorized or revoked", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `cross-task-${process.pid}`);
  const centrifugo = createCentrifugoServerApi();
  const live = new TaskBoard(db, {
    realtime: new CentrifugoConversationRealtime(centrifugo),
    publisher: centrifugo,
  });
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
    await db.conversationMember.updateMany({
      where: { conversationId: secret.id, userId: DEV_BROWSER_USER.id },
      data: { leftAt: new Date() },
    });
    const renamed = `e2e-xref-site-${tail}`;
    await db.conversation.update({ where: { id: launch.id }, data: { channelName: renamed } });
    const agentMember = await db.conversationMember.create({
      data: { conversationId: here.id, workspaceId, agentId: agent.id },
    });
    const seeded = await db.message.create({
      data: {
        conversationId: here.id,
        workspaceId,
        senderMemberId: agentMember.id,
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
    const directTitle = `Draft the release notes ${tail}`;
    const label = (title: string) =>
      `[...document.querySelectorAll(".message-markdown [data-task-status]")].find((el) => el.textContent === ${JSON.stringify(title)})`;
    const chip = (title: string) => `${label(title)}?.closest("[role=button]")`;
    const settled = () => browser("wait", "--fn", animationsSettled());
    const noPopup = `(${taskDetailPanels}.length === 0 && ${nonTaskDialogs(true)}.length === 0)`;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${chip(launchTitle)} != null && ${chip(directTitle)} != null`,
    );

    expect(await evaluate<string>(`${chip(launchTitle)}.getAttribute("aria-label")`)).toBe(
      `${launchTitle}, To do, #${launchTask} #${renamed}`,
    );
    expect(await evaluate<string>(`${chip(directTitle)}.getAttribute("aria-label")`)).toEndWith(
      `#${directTask} DM with @${agent.name}`,
    );

    const seededMarkdown = `document.querySelector('[data-message-id="${seeded.id}"] .message-markdown')`;
    const body = await evaluate<string>(`${seededMarkdown}.textContent`);
    expect(body).toContain("Task you can't view waits");
    expect(body).not.toContain(`Secret plan`);
    expect(body).not.toContain(secret.channelName!);
    expect(body).not.toContain(`#${secretTask}`);

    const hiddenLockCheck = await evaluate<{
      count: number;
      text: string;
      hasSvg: boolean;
      tabIndexAttr: string | null;
      interactiveAncestor: boolean;
      focusedAfterCall: boolean;
      html: string;
    }>(`(() => {
      const badges = [...${seededMarkdown}.querySelectorAll("[data-task-hidden]")];
      const badge = badges[0];
      if (!badge) return { count: 0, text: "", hasSvg: false, tabIndexAttr: null, interactiveAncestor: false, focusedAfterCall: false, html: "" };
      badge.focus();
      return {
        count: badges.length,
        text: badge.textContent ?? "",
        hasSvg: badge.querySelector("svg") !== null,
        tabIndexAttr: badge.getAttribute("tabindex"),
        interactiveAncestor: badge.closest("button, a, [role='button'], [tabindex]") !== null,
        focusedAfterCall: document.activeElement === badge,
        html: badge.outerHTML,
      };
    })()`);
    expect(hiddenLockCheck.count).toBe(1);
    expect(hiddenLockCheck.text).toBe("Task you can't view");
    expect(hiddenLockCheck.hasSvg).toBe(true);
    expect(hiddenLockCheck.tabIndexAttr).toBeNull();
    expect(hiddenLockCheck.interactiveAncestor).toBe(false);
    expect(hiddenLockCheck.focusedAfterCall).toBe(false);
    expect(hiddenLockCheck.html).not.toContain(`Secret plan`);
    expect(hiddenLockCheck.html).not.toContain(secret.channelName!);
    expect(hiddenLockCheck.html).not.toContain(`#${secretTask}`);

    await browser("click", `[data-message-id="${seeded.id}"] [data-task-hidden]`);
    await Bun.sleep(250);
    expect(await evaluate<boolean>(noPopup)).toBe(true);
    expect(await evaluate<string>(`location.search`)).not.toContain("otherTask");

    expect(await evaluate<boolean>(`${chip(`Local follow-up ${tail}`)} != null`)).toBe(true);

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
    ).toEqual([launchTitle, directTitle]);
    expect(await evaluate<string>(`${typedBody}.textContent`)).toContain(
      `#${secret.channelName}:#${secretTask} stays.`,
    );
    expect(
      await evaluate<number>(`${typedBody}.querySelectorAll("[data-mention-agent-id]").length`),
    ).toBe(0);

    const peekShown = `[...document.querySelectorAll("[data-task-locator]")].some((el) => el.textContent === "#${launchTask}${renamed}" && el.querySelector(".avatar-group") !== null)`;
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
    await browser("click", "textarea[data-composer]");
    await evaluate(`${chip(launchTitle)}.setAttribute("data-e2e-launch", "") ?? true`);
    await browser("hover", "[data-e2e-launch]");
    await browser("wait", "--fn", peekShown);
    await browser("screenshot", join(artifacts, "labels.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, "labels-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await settled();

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

    const onThisPage = `location.pathname.endsWith("/channel/${here.id}")`;
    const popupOf = (title: string) =>
      `${taskDetailPanels}.find((el) => el.textContent.includes(${JSON.stringify(title)}))`;
    const closePopup = async () => {
      await settled();
      await browser("click", `[role="dialog"] button[aria-label="Close"]`);
    };
    await browser("click", "[data-e2e-launch]");
    await browser("wait", "--fn", `${popupOf(launchTitle)} != null && ${onThisPage}`);
    await browser("wait", "--fn", `${popupOf(launchTitle)}.querySelector("textarea") != null`);
    expect(await evaluate<string>(`location.search`)).toContain(
      `otherTask=channel%3A${launch.id}%3A${launchTask}`,
    );
    await settled();
    await browser("screenshot", join(artifacts, "popup.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, "popup-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    await browser("back");
    await browser("wait", "--fn", `${noPopup} && ${onThisPage} && ${chip(launchTitle)} != null`);
    expect(await evaluate<string>(`location.search`)).not.toContain("otherTask");
    await browser("forward");
    await browser("wait", "--fn", `${popupOf(launchTitle)} != null && ${onThisPage}`);
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${popupOf(launchTitle)} != null && ${onThisPage}`,
    );

    await closePopup();
    await browser("wait", "--fn", noPopup);
    expect(await evaluate<string>(`location.search`)).not.toContain("otherTask");
    expect(await evaluate<boolean>(onThisPage)).toBe(true);

    await evaluate(`${chip(directTitle)}.setAttribute("data-e2e-direct", "") ?? true`);
    await browser("click", "[data-e2e-direct]");
    await browser("wait", "--fn", `${popupOf(directTitle)} != null && ${onThisPage}`);
    await closePopup();
    await browser("wait", "--fn", noPopup);

    await browser(
      "open",
      `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}?otherTask=channel:${crypto.randomUUID()}:1`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && !location.search.includes("otherTask") && ${chip(launchTitle)} != null`,
    );
    expect(await evaluate<boolean>(noPopup)).toBe(true);

    await browser("set", "viewport", "390", "844");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${chip(launchTitle)} != null`);
    await browser("screenshot", join(artifacts, "phone.png"));
    await evaluate(`${chip(launchTitle)}.scrollIntoView({ block: "center" }) ?? true`);
    await evaluate(`${chip(launchTitle)}.setAttribute("data-e2e-launch", "") ?? true`);
    await browser("click", "[data-e2e-launch]");
    await browser("wait", "--fn", `${popupOf(launchTitle)} != null && ${onThisPage}`);
    await settled();
    await browser("screenshot", join(artifacts, "popup-phone.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, "popup-phone-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    await db.conversation.update({ where: { id: launch.id }, data: { visibility: "private" } });
    await db.conversationMember.updateMany({
      where: { conversationId: launch.id, userId: DEV_BROWSER_USER.id },
      data: { leftAt: new Date() },
    });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/channel/${here.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && ${chip(directTitle)} != null && ${seededMarkdown}?.querySelectorAll("[data-task-hidden]").length === 2`,
    );
    const revokedCheck = await evaluate<{
      body: string;
      html: string;
      hiddenCount: number;
      anyFocusable: boolean;
      typedText: string;
      typedStatusCount: number;
    }>(`(() => {
      const md = ${seededMarkdown};
      const badges = [...md.querySelectorAll("[data-task-hidden]")];
      const anyFocusable = badges.some((badge) => {
        badge.focus();
        return (
          document.activeElement === badge ||
          badge.getAttribute("tabindex") !== null ||
          badge.closest("button, a, [role='button'], [tabindex]") !== null
        );
      });
      const typedEl = ${typedBody};
      return {
        body: md.textContent ?? "",
        html: md.innerHTML,
        hiddenCount: badges.length,
        anyFocusable,
        typedText: typedEl?.textContent ?? "",
        typedStatusCount: typedEl?.querySelectorAll("[data-task-status]").length ?? -1,
      };
    })()`);
    expect(revokedCheck.hiddenCount).toBe(2);
    expect(revokedCheck.anyFocusable).toBe(false);
    expect(revokedCheck.body).toContain("Task you can't view is next");
    expect(revokedCheck.body).not.toContain(launchTitle);
    expect(revokedCheck.body).not.toContain(renamed);
    expect(revokedCheck.body).not.toContain(launch.channelName!);
    expect(revokedCheck.html).not.toContain(launchTitle);
    expect(revokedCheck.html).not.toContain(renamed);
    expect(revokedCheck.typedText).toContain(`#${renamed}:#${launchTask}`);
    expect(revokedCheck.typedStatusCount).toBe(1);

    await browser("click", `[data-message-id="${seeded.id}"] [data-task-hidden]`);
    await Bun.sleep(250);
    expect(await evaluate<boolean>(noPopup)).toBe(true);
    expect(await evaluate<string>(`location.search`)).not.toContain("otherTask");
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
