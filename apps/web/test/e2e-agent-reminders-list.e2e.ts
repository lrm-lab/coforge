import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { resolveTimeZone } from "#src/lib/dates";
import { hour12For, isTimeFormat } from "#src/lib/time-format";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent's Reminders tab (task #coforge-designer-team:#126): the next to fire first, a repeat
 * rule as a sentence, the place by name and face and never a raw target or id, one row each.
 * Seeds an Agent with many reminders of every kind, its direct conversation and a channel, and
 * removes them after the run. Screenshots, desktop and phone, light and dark, English and
 * Chinese, are under `.artifacts/e2e/agent-reminders-list/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/agent-reminders-list");
const MINUTE = 60_000;
const RUNTIME = {
  runtime: "claude-code",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

test("an Agent's reminders read in firing order with their places named", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `reminders-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const viewer = await db.user.findUniqueOrThrow({
    where: { id: DEV_BROWSER_USER.id },
    select: { displayName: true, preferences: { select: { timeZone: true, timeFormat: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-reminders-${suffix}`,
      name: `e2e-reminders-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-reminders-${suffix}`,
      displayName: "Remy",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: RUNTIME,
    },
  });
  const empty = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-reminders-empty-${suffix}`,
      displayName: "Nora",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: RUNTIME,
    },
  });
  const members = { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] };
  const direct = await db.conversation.create({
    data: { workspaceId, directKey: agentDirectKey(DEV_BROWSER_USER.id, agent.id), members },
    include: { members: true },
  });
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `release-${suffix}`, visibility: "public", members },
    include: { members: true },
  });
  const post = async (conversation: typeof direct, body: string) => {
    const sender = conversation.members.find((member) => member.agentId === agent.id)!;
    return db.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        senderMemberId: sender.id,
        body,
        sequence: 1,
      },
    });
  };
  const inDirect = await post(direct, "Noted, I'll remind you.");
  const inChannel = await post(channel, "I'll check the release every morning.");
  const now = Date.now();
  await browser("open", "about:blank");
  const browserZone = await evaluate<string>("Intl.DateTimeFormat().resolvedOptions().timeZone");
  const viewerZone = resolveTimeZone(viewer.preferences?.timeZone, browserZone);
  const preferredTimeFormat = viewer.preferences?.timeFormat;
  const timeFormat = isTimeFormat(preferredTimeFormat) ? preferredTimeFormat : null;
  // Created in an order unlike their firing order; the deleted one's message is gone.
  const seeds: [title: string, minutes: number, repeat: string | null, messageId: string][] = [
    ["Follow up on the design review", 6 * 24 * 60, null, inDirect.id],
    ["Check whether the release went green", 34, "every:1h", inChannel.id],
    ["Post the weekly summary to the team", 4 * 24 * 60, "weekly:mon,wed,fri@09:00", inChannel.id],
    ["Ping Frank about the pricing page", 48, "every:15m", inDirect.id],
    [
      "整理本周所有未关闭的任务并逐条确认负责人、截止时间和当前阻塞原因，然后把结果按优先级排序后发到频道里，同时提醒每一位负责人在明天上午十点之前更新进度".repeat(
        2,
      ),
      90,
      "daily@09:30",
      inChannel.id,
    ],
    [`Check https://example.com/${"a".repeat(120)}`, 3 * 60, "every:1d", inDirect.id],
    ["Reminder whose conversation was deleted", 5 * 60, "every:3d", randomUUID()],
    ...Array.from(
      { length: 7 },
      (_, index) =>
        [`Routine check ${index + 1}`, (index + 2) * 24 * 60 + 7, "every:2h", inDirect.id] as [
          string,
          number,
          string,
          string,
        ],
    ),
  ];
  const orderedSeeds = [...seeds].sort((a, b) => a[1] - b[1]);
  const fireAt = new Date(now + orderedSeeds[0]![1] * MINUTE).toISOString();
  const formatClock = (zone: string) =>
    evaluate<string>(
      `new Intl.DateTimeFormat("en", ${JSON.stringify({
        dateStyle: "medium",
        timeStyle: "short",
        hour12: hour12For(timeFormat),
        timeZone: zone,
      })}).format(new Date(${JSON.stringify(fireAt)}))`,
    );
  const viewerClock = await formatClock(viewerZone);
  const scheduleZone =
    (await formatClock("Pacific/Kiritimati")) === viewerClock
      ? "America/Los_Angeles"
      : "Pacific/Kiritimati";
  for (const [title, minutes, repeat, messageId] of seeds)
    await db.reminder.create({
      data: {
        workspaceId,
        ownerAgentId: agent.id,
        computerId: computer.id,
        title,
        target: messageId === inChannel.id ? `#${channel.channelName}` : `@dev:${messageId}`,
        messageId,
        fireAt: new Date(now + minutes * MINUTE),
        repeat,
        timezone: scheduleZone,
      },
    });
  const firing = orderedSeeds.map(([title]) => title);

  const rows = `[...document.querySelectorAll("[data-reminder-row]")]`;
  const open = async (locale: string, agentId: string, ready: string) => {
    await browser(
      "open",
      `${origin}/${locale}/w/${workspace.slug}/dm/${direct.id}?profile=agent:${agentId}&agentTab=reminders`,
    );
    await browser("wait", "--fn", `${pageHydrated} && (${ready})`);
    await browser("wait", "800");
  };
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, device] of [
      [1440, 900, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await open("en", agent.id, `${rows}.length === ${seeds.length}`);
      await shots(`${device}-en`);
      await open("zh-CN", agent.id, `${rows}.length === ${seeds.length}`);
      await shots(`${device}-zh`);
      await open("en", empty.id, `document.body.innerText.includes("No reminders yet")`);
      await shots(`${device}-empty`);
    }

    await open("en", agent.id, `${rows}.length === ${seeds.length}`);
    const read = await evaluate<{
      titles: string[];
      text: string;
      places: string[];
      firstTime: { instant: string; label: string };
    }>(`({
      firstTime: {
        instant: ${rows}[0].querySelector("time").dateTime,
        label: ${rows}[0].querySelector("time span").textContent,
      },
      titles: ${rows}.map((row) => row.querySelector("p").textContent),
      text: ${rows}.map((row) => row.innerText).join("\\n"),
      places: ${rows}.map((row) => row.querySelector("a")?.innerText.trim() ?? ""),
    })`);
    expect(read.titles).toEqual(firing);
    expect(read.firstTime).toEqual({ instant: fireAt, label: `· ${viewerClock}` });
    // A repeat rule is a sentence: never "Every 1 hours".
    expect(read.text).toContain("Every hour");
    expect(read.text).toContain("Every 15 minutes");
    expect(read.text).not.toMatch(/Every 1 /);
    // No place is a raw target or id; a direct conversation is its person, a channel its name.
    expect(read.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(read.text).not.toContain("@dev:");
    expect(read.places[firing.indexOf("Ping Frank about the pricing page")]).toBe(
      viewer.displayName,
    );
    expect(read.places[firing.indexOf("Check whether the release went green")]).toBe(
      channel.channelName!,
    );
    expect(read.places[firing.indexOf("Reminder whose conversation was deleted")]).toBe("");
  } finally {
    await browser("close").catch(() => undefined);
    await db.reminder
      .deleteMany({ where: { ownerAgentId: { in: [agent.id, empty.id] } } })
      .catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [direct.id, channel.id] } } })
      .catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [agent.id, empty.id] } } })
      .catch(() => undefined);
    await db.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
