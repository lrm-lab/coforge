import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { SystemNotice } from "#src/features/conversations/system-notice";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Consecutive system notices fold as Raft's do (task #412): a run that spans days is one group,
 * drawn under its first notice's day, and a later day's notice in it writes its date before its
 * time; the day divider comes back for the message after the group. Every notice line, folded or
 * lone, is centred on a hairline with its time shown, and a phone never scrolls sideways.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel and its
 * messages are seeded per run and removed after it. Screenshots (light folded and open, dark,
 * a phone) are written under `.amp/e2e/system-notice-fold/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/system-notice-fold");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

test("a run of notices folds across days and each notice sits centred on a rule", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `system-fold-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const name = `e2e-fold-${suffix}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: name,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
    include: { members: true },
  });
  const me = channel.members[0]!;
  let sequence = 0;
  // Noon UTC three days ago and yesterday: each run of minutes stays on one calendar day in any
  // zone within 11 hours of UTC, whatever the clock reads when the test runs.
  const noonUtc = (daysAgo: number) => {
    const day = new Date(Date.now() - daysAgo * DAY_MS);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
  };
  const earlier = noonUtc(3);
  const later = noonUtc(1);
  const post = async (createdAt: number, body: string, system?: SystemNotice) => {
    sequence += 1;
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: system ? null : me.id,
        body,
        createdAt: new Date(createdAt),
      },
    });
    if (system)
      await db.systemMessage.create({
        data: {
          messageId: message.id,
          conversationId: channel.id,
          workspaceId,
          kind: system.kind,
          params: system.params,
        },
      });
    return message;
  };
  const coder = { memberId: null, handle: "coder", displayName: "Coder" };
  const task = { taskId: crypto.randomUUID(), number: 7, title: "Fold the notices" };
  await post(earlier, `Before ${suffix}`);
  const older = await post(earlier + MINUTE_MS, '📋 1 new task created: #7 "Fold the notices"', {
    kind: "task.created",
    params: { tasks: [task] },
  });
  const newer = await post(later, "Coder made @coder the coordinator", {
    kind: "channel.coordinator_changed",
    params: { channelId: channel.id, channelName: name, actor: coder, next: coder },
  });
  await post(later + MINUTE_MS, `After ${suffix}`);
  const lone = await post(later + 2 * MINUTE_MS, '📌 coder claimed #7 "Fold the notices"', {
    kind: "task.claimed",
    params: { claimer: coder, task },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  const group = `document.querySelector('li[data-system-group]')`;
  const row = (id: string) => `document.querySelector('[data-message-id="${id}"]')`;
  /** The line's text is centred in its row, and a hairline of 16px or more is on each side. */
  const centredOnRule = (line: string) =>
    evaluate<boolean>(`(() => {
      const line = ${line};
      const box = line.getBoundingClientRect();
      const rules = [...line.children].filter((el) => el.getAttribute("aria-hidden") === "true");
      const content = [...line.children].find((el) => !rules.includes(el)).getBoundingClientRect();
      const offCentre = Math.abs(content.left + content.width / 2 - (box.left + box.width / 2));
      return rules.length === 2 && rules.every((el) => el.getBoundingClientRect().width >= 16) && offCentre <= 2;
    })()`);
  const open = async (locale = "en") => {
    await browser("open", page.replace("/en/", `/${locale}/`));
    await browser(
      "wait",
      "--fn",
      `${group} !== null && ${row(lone.id)} !== null && ${pageHydrated}`,
    );
  };
  const expand = async () => {
    await browser("eval", `${group}.querySelector("button[aria-expanded]").click()`);
    await browser("wait", "--fn", `${row(newer.id)} !== null`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await open();
    // Two days apart, one group: the summary names both kinds.
    expect(await evaluate<string>(`${group}.textContent`)).toContain(
      "2 system updates: 1 task update",
    );
    expect(await centredOnRule(`${group}.querySelector("[data-scroll-anchor]")`)).toBe(true);
    // The lone notice keeps its own row, centred, its time shown without a hover.
    const loneLine = `${row(lone.id)}.querySelector('[data-message="system"]')`;
    expect(await centredOnRule(loneLine)).toBe(true);
    expect(
      await evaluate<boolean>(
        `${loneLine}.querySelector("time").checkVisibility({ opacityProperty: true })`,
      ),
    ).toBe(true);
    // The group is drawn under the older day; the later day's divider is back above the next
    // message.
    const dividers = (li: string) =>
      evaluate<string[]>(
        `[...${li}.querySelectorAll("[data-day-divider]")].map((el) => el.textContent)`,
      );
    // The message above the group opened the older day; the group adds no divider of its own.
    const [olderDay] = await dividers(`${group}.previousElementSibling`);
    const [nextDay] = await dividers(`${group}.nextElementSibling`);
    expect(await dividers(group)).toEqual([]);
    expect(olderDay).toBeDefined();
    expect(nextDay).toBeDefined();
    expect(nextDay).not.toBe(olderDay);
    // The scroll anchor finds the group by any notice it folds.
    expect(await evaluate<string>(`${group}.dataset.systemGroupMembers`)).toBe(
      `${older.id} ${newer.id}`,
    );
    await browser("screenshot", join(artifacts, "folded.png"));

    await expand();
    const time = (id: string) => evaluate<string>(`${row(id)}.querySelector("time").textContent`);
    // The older notice is on the group's day: its time alone. The later day's writes its date
    // ("Nov 2, 12:00 PM"; with its year when the year has turned since).
    expect(await time(older.id)).toMatch(/^\d\d:\d\d/);
    expect(await time(newer.id)).toMatch(/^[A-Z][a-z]{2} \d+, (\d{4}, )?\d\d:\d\d/);
    await browser("screenshot", join(artifacts, "open.png"));

    // In Chinese the date goes before the same clock with a space: "11月2日 20:00".
    await open("zh-CN");
    await expand();
    expect(await time(newer.id)).toMatch(/^(\d+月\d+日|\d{4}\.\d+\.\d+) \d\d:\d\d/);
    await browser("screenshot", join(artifacts, "zh.png"));

    await browser("eval", `localStorage.setItem("coforge-theme", "dark")`);
    await open();
    await expand();
    await browser("screenshot", join(artifacts, "dark.png"));
    await browser("eval", `localStorage.removeItem("coforge-theme")`);

    // A phone: the notice is cut, the stream is not pushed sideways, the time stays whole.
    await browser("set", "viewport", "390", "844");
    await open();
    await expand();
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    expect(
      await evaluate<boolean>(
        `(() => { const t = ${row(newer.id)}.querySelector("time"); return t.scrollWidth <= t.clientWidth && t.getBoundingClientRect().right <= 390; })()`,
      ),
    ).toBe(true);
    // The summary stays one line, cut before its chevron is. Waited for, not read once: the
    // chevron turns with a transition, and a box measured mid-turn is wider than the icon.
    await browser(
      "wait",
      "--fn",
      `(() => {
        const button = ${group}.querySelector("button[aria-expanded]");
        const box = button.getBoundingClientRect();
        const chevron = button.querySelector("svg").getBoundingClientRect();
        return box.height <= 32 && chevron.width > 0 && chevron.right <= box.right;
      })()`,
    );
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-theme")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
