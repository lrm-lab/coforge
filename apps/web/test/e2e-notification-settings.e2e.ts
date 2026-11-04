import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Settings › Notifications (task #469, in Raft's order): this device first, named with its last
 * delivery and why it failed, and no other device; then a pause (a time of one's own refused in
 * the past, saved within a year) and quiet hours, and the content settings, which save at once
 * and stay after a reload. Desktop and phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. The browser's push
 * subscription is stubbed by an init script to one of two seeded devices, so the page has a
 * device of its own. The dev user's settings and the devices are put back after the run.
 * Screenshots are written under `.amp/e2e/notification-settings/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/notification-settings");

test("notification settings: this device, a pause of one's own, and settings that save at once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `notif-settings-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const userId = DEV_BROWSER_USER.id;
  const before = await db.userNotificationSettings.findUnique({ where: { userId } });
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const stub = join(tmpdir(), `notif-settings-push-stub-${tail}.js`);
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
            ? { lastFailureAt: now, lastFailureReason: "unreachable" }
            : { lastSuccessAt: now }),
        },
      });
    await mkdir(artifacts, { recursive: true });
    // This browser's subscription is the first seeded device's.

    await writeFile(
      stub,
      `(() => {
        const subscription = { endpoint: ${JSON.stringify(endpoints[0])} };
        if (typeof PushManager !== "undefined")
          PushManager.prototype.getSubscription = async () => subscription;
        const container = navigator.serviceWorker;
        if (!container) return;
        const real = container.getRegistration.bind(container);
        container.getRegistration = async (...args) =>
          (await real(...args)) ?? { pushManager: { getSubscription: async () => subscription } };
      })();`,
    );
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

    await browser("--init-script", stub, "set", "viewport", "1280", "900");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${text}.includes("macOS · Chrome")`);
    // This device, first, saying why it last failed; no other device.
    expect(await evaluate<boolean>(`${text}.includes("iPhone · Safari")`)).toBe(false);
    expect(await evaluate<boolean>(`${text}.indexOf("本机") < ${text}.indexOf("暂停通知")`)).toBe(
      true,
    );
    expect(await evaluate<boolean>(`${text}.includes("连不上它的推送服务")`)).toBe(true);
    // With message notifications off the page says these do nothing, and the test waits for them;
    // the quiet hours' time zone opens "Language and region".
    expect(await evaluate<boolean>(`${text}.includes("消息通知已关闭")`)).toBe(true);
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "发送测试通知")?.disabled === true`,
      ),
    ).toBe(true);
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("a")].some((a) => a.href.includes("section=language-region"))`,
      ),
    ).toBe(true);
    // Sound off and quiet hours on, each saved at once.
    await evaluate(
      `([...document.querySelectorAll('[role="switch"], input[role="switch"]')].find((el) => (el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? "").includes("声音")) ?? document.querySelector('input[aria-label="声音"]')).click() ?? true`,
    );
    // Each control waits while a save is in flight.
    await browser(
      "wait",
      "--fn",
      `!document.querySelector('input[aria-label="安静时段"]').disabled`,
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

    // A pause of one's own: a time in the past is refused, one within a year is saved.
    const press = async (selector: string) => {
      await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
      await browser("click", "[data-press]");
      await evaluate(
        `(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`,
      );
    };
    await press(`document.querySelector('[aria-label="暂停通知"]')`);
    const custom = `[...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes("自定义"))`;
    await browser("wait", "--fn", `${custom} != null`);
    await press(custom);
    const until = `document.querySelector('input[type="datetime-local"]')`;
    await browser("wait", "--fn", `${until} != null`);
    const typeUntil = (value: string) =>
      evaluate(
        `(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(${until}, ${JSON.stringify(value)}), ${until}.dispatchEvent(new Event("input", { bubbles: true })), true)`,
      );
    const pauseButton = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "暂停")`;
    await typeUntil("2020-01-01T09:00");
    await browser("wait", "--fn", `${text}.includes("请选一年以内的未来时间")`);
    expect(await evaluate<boolean>(`${pauseButton}.disabled`)).toBe(true);
    await shoot("desktop-custom-pause");
    // Three days ahead at 18:00, on the browser's clock, which is the one the page reads.
    const value = await evaluate<string>(
      `(() => { const d = new Date(Date.now() + 3 * 864e5); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T18:00"; })()`,
    );
    const end = await evaluate<number>(`new Date(${JSON.stringify(value)}).getTime()`);
    await typeUntil(value);
    await browser("wait", "--fn", `!${pauseButton}.disabled`);
    await press(pauseButton);
    await browser("wait", "--fn", `${text}.includes("恢复")`);
    const pausedUntil = async () =>
      (await db.userNotificationSettings.findUnique({ where: { userId } }))?.pausedUntil;
    for (let tries = 0; tries < 40 && !(await pausedUntil()); tries++) await Bun.sleep(250);
    expect((await pausedUntil())?.getTime()).toBe(end);
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "恢复")?.disabled === false`,
    );
    await press(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "恢复")`,
    );
    for (let tries = 0; tries < 40 && (await pausedUntil()); tries++) await Bun.sleep(250);
    expect(await pausedUntil()).toBeNull();

    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    // A phone opens on the list of settings; Notifications opens from it.
    const notificationsItem = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "通知")`;
    await browser("wait", "--fn", `${pageHydrated} && ${notificationsItem} != null`);
    await press(notificationsItem);
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll("h3")].some((h) => h.textContent === "macOS · Chrome" && h.getClientRects().length > 0)`,
    );
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await shoot("phone");
  } finally {
    await browser("close").catch(() => undefined);
    await rm(stub, { force: true });
    await db.webPushSubscription
      .deleteMany({ where: { endpoint: { in: endpoints } } })
      .catch(() => undefined);
    await db.userNotificationSettings.deleteMany({ where: { userId } }).catch(() => undefined);
    if (before) await db.userNotificationSettings.create({ data: before }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
