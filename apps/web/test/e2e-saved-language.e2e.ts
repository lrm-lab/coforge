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
