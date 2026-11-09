import { afterAll, expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #4): the language saved in Settings is the person's on every page of the
 * Workspace. An address in the other language (a link someone shared) switches to the saved one on
 * Members as it does on Settings, rather than Settings alone. Screenshots are written under
 * `.amp/e2e/saved-language/`.
 */
const fx = setupAgentReplying({ artifactsName: "saved-language" });

let before: { language: string | null } | null = null;
afterAll(async () => {
  await fx.db.userPreference.upsert({
    where: { userId: DEV_BROWSER_USER.id },
    create: { userId: DEV_BROWSER_USER.id, language: before?.language ?? null },
    update: { language: before?.language ?? null },
  });
});

test("an English address opens in the saved Chinese on Members and on Settings", async () => {
  before = await fx.db.userPreference.findUnique({ where: { userId: DEV_BROWSER_USER.id } });
  await fx.db.userPreference.upsert({
    where: { userId: DEV_BROWSER_USER.id },
    create: { userId: DEV_BROWSER_USER.id, language: "zh-CN" },
    update: { language: "zh-CN" },
  });
  for (const page of ["members", "settings"]) {
    await fx.browser("open", `${fx.proxy.origin}${fx.workspacePath}/${page}`);
    await fx.until(
      `location.pathname.startsWith("/zh-CN/") && document.documentElement?.lang === "zh-CN"`,
      30_000,
    );
    await fx.screenshot(`${page}-zh.png`);
  }
  expect(await fx.evaluate<string>("location.pathname")).toEndWith("/settings");
}, 120_000);

test("switching to English in Settings turns the page English at once, and it stays after a reload", async () => {
  await fx.db.userPreference.upsert({
    where: { userId: DEV_BROWSER_USER.id },
    create: { userId: DEV_BROWSER_USER.id, language: "zh-CN" },
    update: { language: "zh-CN" },
  });
  const zh = fx.workspacePath.replace(/^\/en\//, "/zh-CN/");
  await fx.browser("open", `${fx.proxy.origin}${zh}/settings?section=language-region`);
  const select = `document.querySelector('button[aria-label="界面语言"]')`;
  await fx.until(`${select} !== null`, 30_000);
  await fx.evaluate(`${select}.click()`);
  const english = `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes("English"))`;
  await fx.until(`${english} !== undefined`, 10_000);
  await fx.evaluate(`${english}.click()`);
  const save = `[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "保存" && !el.disabled)`;
  await fx.until(`${save} !== undefined`, 10_000);
  await fx.evaluate(`${save}.click()`);
  const englishPage = `location.pathname.startsWith("/en/") && document.documentElement?.lang === "en"`;
  await fx.until(englishPage, 30_000);
  await fx.screenshot("settings-switched-en.png");
  expect(
    (await fx.db.userPreference.findUniqueOrThrow({ where: { userId: DEV_BROWSER_USER.id } }))
      .language,
  ).toBe("en");
  await fx.browser("open", `${fx.proxy.origin}${fx.workspacePath}/members`);
  await fx.until(`document.readyState === "complete"`, 30_000);
  await Bun.sleep(2_000);
  expect(await fx.evaluate<boolean>(englishPage)).toBe(true);
}, 120_000);
