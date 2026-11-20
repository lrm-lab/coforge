import { afterAll, expect, test } from "bun:test";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

const fx = setupAgentReplying({ artifactsName: "saved-language" });

let before: { language: string | null } | null = null;
afterAll(async () => {
  await fx.db.userPreference.upsert({
    where: { userId: DEV_BROWSER_USER.id },
    create: { userId: DEV_BROWSER_USER.id, language: before?.language ?? null },
    update: { language: before?.language ?? null },
  });
});

async function seedLanguage(language: string) {
  await fx.db.userPreference.upsert({
    where: { userId: DEV_BROWSER_USER.id },
    create: { userId: DEV_BROWSER_USER.id, language },
    update: { language },
  });
}

async function savedLanguage() {
  return (await fx.db.userPreference.findUniqueOrThrow({ where: { userId: DEV_BROWSER_USER.id } }))
    .language;
}

const languageCard = (label: string) =>
  `(document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.closest("div.rounded-xl") ?? null)`;
const saveButtons = (card: string) =>
  `[...((${card})?.querySelectorAll("button") ?? [])].filter((el) => ["保存", "Save"].includes(el.textContent.trim())).length`;
const saved = `Number(sessionStorage.getItem("__languageSaves") ?? 0)`;
const watchSaves = `(() => {
  sessionStorage.setItem("__languageSaves", "0");
  const send = window.fetch;
  window.fetch = function (input, init) {
    const url = String(typeof input === "string" ? input : input?.url);
    const body = typeof init?.body === "string" ? init.body : "";
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/_serverFn/") && body.includes('"language"')) {
      sessionStorage.setItem("__languageSaves", String(Number(sessionStorage.getItem("__languageSaves")) + 1));
    }
    return send.apply(this, arguments);
  };
  return true;
})()`;

async function pickLanguage(label: string, option: string) {
  await fx.browser("click", `button[aria-label=${JSON.stringify(label)}]`);
  const text = JSON.stringify(option);
  await fx.until(
    `[...document.querySelectorAll('[role="option"]')].some((el) => el.textContent.includes(${text}))`,
    10_000,
  );
  await fx.evaluate(
    `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes(${text})).click()`,
  );
  await fx.until(`document.querySelector('[role="listbox"]') === null`, 10_000);
}

test("choosing a language saves it at once and keeps it on every page", async () => {
  before = await fx.db.userPreference.findUnique({ where: { userId: DEV_BROWSER_USER.id } });
  await seedLanguage("zh-CN");
  for (const page of ["members", "settings"]) {
    await fx.browser("open", `${fx.proxy.origin}${fx.workspacePath}/${page}`);
    await fx.until(
      `location.pathname.startsWith("/zh-CN/") && document.documentElement?.lang === "zh-CN"`,
      30_000,
    );
    await fx.screenshot(`${page}-zh.png`);
  }
  expect(await fx.evaluate<string>("location.pathname")).toEndWith("/settings");

  await fx.browser(
    "open",
    `${fx.proxy.origin}${fx.workspacePath}/settings?section=language-region`,
  );
  const chineseCard = languageCard("界面语言");
  await fx.until(`${chineseCard} !== null`, 30_000);
  expect(await fx.evaluate<number>(saveButtons(chineseCard))).toBe(0);
  await fx.screenshot("language-card-zh.png");

  await fx.evaluate(watchSaves);
  await pickLanguage("界面语言", "English");
  await fx.until(
    `location.pathname.startsWith("/en/") && document.documentElement?.lang === "en"`,
    30_000,
  );
  expect(await savedLanguage()).toBe("en");
  expect(await fx.evaluate<number>(saved)).toBeGreaterThan(0);
  await fx.screenshot("settings-switched-en.png");

  await fx.browser("reload");
  await fx.until(
    `location.pathname.startsWith("/en/") && document.documentElement?.lang === "en"`,
    30_000,
  );
  const englishCard = languageCard("Display language");
  await fx.until(`${englishCard} !== null`, 30_000);
  expect(await fx.evaluate<number>(saveButtons(englishCard))).toBe(0);
  expect(await savedLanguage()).toBe("en");

  await fx.evaluate(watchSaves);
  await fx.evaluate(
    `(() => { window.__stayed = false; setTimeout(() => { window.__stayed = true; }, 50); return true; })()`,
  );
  await pickLanguage("Display language", "English");
  await fx.browser("click", `button[aria-label="Display language"]`);
  await fx.until(`document.querySelector('[role="listbox"]') !== null`, 10_000);
  await fx.browser("press", "Escape");
  await fx.until(`document.querySelector('[role="listbox"]') === null`, 10_000);
  await Bun.sleep(1_500);
  expect(await fx.evaluate<number>(saved)).toBe(0);
  expect(await fx.evaluate<boolean>("window.__stayed === true")).toBe(true);
  expect(await savedLanguage()).toBe("en");

  await pickLanguage("Display language", "Simplified Chinese");
  await fx.until(
    `location.pathname.startsWith("/zh-CN/") && document.documentElement?.lang === "zh-CN"`,
    30_000,
  );
  expect(await savedLanguage()).toBe("zh-CN");
  await fx.screenshot("settings-switched-zh.png");

  await fx.browser("reload");
  await fx.until(
    `location.pathname.startsWith("/zh-CN/") && document.documentElement?.lang === "zh-CN"`,
    30_000,
  );
  expect(await savedLanguage()).toBe("zh-CN");
}, 180_000);
