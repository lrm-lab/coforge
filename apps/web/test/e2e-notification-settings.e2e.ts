import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Settings › Notifications (task #469): the account's pause, quiet hours, preview, sound and phone
 * delay save at once and stay after a reload; the devices list names each browser. Desktop and
 * phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. The dev user's settings
 * and the two seeded devices are put back after the run. Screenshots are written under
 * `.amp/e2e/notification-settings/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/notification-settings");

test("notification settings save at once and list the devices", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `notif-settings-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const userId = DEV_BROWSER_USER.id;
  const before = await db.userNotificationSettings.findUnique({ where: { userId } });
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const endpoints = [
    `https://push.example.test/e2e-${tail}-a`,
    `https://push.example.test/e2e-${tail}-b`,
  ];
  try {
    await db.userNotificationSettings.deleteMany({ where: { userId } });
    const now = new Date();
    for (const [index, endpoint] of endpoints.entries())
      await db.webPushSubscription.create({
        data: {
          userId,
          endpoint,
          p256dh:
            "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
          deviceKind: index === 0 ? "desktop" : "mobile",
          deviceLabel: index === 0 ? "macOS · Chrome" : "iPhone · Safari",
          ...(index === 0
            ? { lastSuccessAt: now }
            : { lastFailureAt: now, lastFailureReason: "unreachable" }),
        },
      });
    await mkdir(artifacts, { recursive: true });
    const page = `${origin}/zh-CN/w/${workspace.slug}/settings?section=notifications`;
    const shoot = async (name: string) => {
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", "--full", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", "--full", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const text = `(document.querySelector("main")?.textContent ?? document.body.textContent)`;

    await browser("set", "viewport", "1280", "900");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${text}.includes("iPhone · Safari")`);
    expect(await evaluate<boolean>(`${text}.includes("macOS · Chrome")`)).toBe(true);
    // The failed device says why; with message notifications off the page says these do nothing;
    // the quiet hours' time zone opens "Language and region".
    expect(await evaluate<boolean>(`${text}.includes("连不上它的推送服务")`)).toBe(true);
    expect(await evaluate<boolean>(`${text}.includes("消息通知已关闭")`)).toBe(true);
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("a")].some((a) => a.href.includes("section=language-region"))`,
      ),
    ).toBe(true);
    // Sound off and quiet hours on, each saved at once.
    await evaluate(
      `([...document.querySelectorAll('[role="switch"], input[role="switch"]')].find((el) => (el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? "").includes("声音")) ?? document.querySelector('input[aria-label="声音"]')).click() ?? true`,
    );
    await evaluate(`(document.querySelector('input[aria-label="安静时段"]')).click() ?? true`);
    await browser("wait", "--fn", `${text}.includes("开始时间")`);
    const saved = async () =>
      db.userNotificationSettings.findUnique({
        where: { userId },
        select: { sound: true, quietHoursEnabled: true },
      });
    for (let tries = 0; tries < 40; tries++) {
      const row = await saved();
      if (row && !row.sound && row.quietHoursEnabled) break;
      await Bun.sleep(250);
    }
    expect(await saved()).toEqual({ sound: false, quietHoursEnabled: true });
    await browser("reload");
    await browser("wait", "--fn", `${pageHydrated} && ${text}.includes("开始时间")`);
    await shoot("desktop");
    // The devices, at the foot of the page.
    await evaluate(
      `([...document.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible").forEach((el) => (el.scrollTop = el.scrollHeight)), true)`,
    );
    await shoot("desktop-devices");

    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${text}.includes("iPhone · Safari")`);
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await shoot("phone");
    await evaluate(
      `([...document.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible").forEach((el) => (el.scrollTop = el.scrollHeight)), true)`,
    );
    await shoot("phone-devices");
  } finally {
    await browser("close").catch(() => undefined);
    await db.webPushSubscription
      .deleteMany({ where: { endpoint: { in: endpoints } } })
      .catch(() => undefined);
    await db.userNotificationSettings.deleteMany({ where: { userId } }).catch(() => undefined);
    if (before) await db.userNotificationSettings.create({ data: before }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
