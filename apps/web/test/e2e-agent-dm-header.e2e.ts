import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * An Agent DM's header keeps the avatar whole beside a long name. Seeds an Agent with no Computer
 * and removes it after the run. Screenshots, light, dark and phone, are written under
 * `.amp/e2e/agent-dm-header/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
// The Agent's status reaches the page over Centrifugo, so through the page's own origin.
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-dm-header");

test("a long Agent name leaves the header's avatar whole", async () => {
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `dm-header-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-head-${suffix}`,
      displayName: `Header Agent With A Long Name ${suffix}`,
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
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  // The header is the one whose title is this Agent: the conversation list has a header too.
  const title = `[...document.querySelectorAll("h1")].find((h1) => h1.textContent.includes(${JSON.stringify(agent.displayName)}))`;
  const measure = `(() => {
    const name = ${title};
    const header = name.closest("header");
    const avatar = header.querySelector("button[aria-label^='Open']");
    const box = avatar.getBoundingClientRect();
    const tabs = header.querySelector('[role="tablist"]')?.getBoundingClientRect();
    const title = name.getBoundingClientRect();
    return { avatarWidth: Math.round(box.width), clear: box.right <= title.left && (!tabs || tabs.top >= title.bottom || title.right <= tabs.left), text: header.textContent.slice(0, 120) };
  })()`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/members`);
    const open = `[...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Private Chat" && el.parentElement?.parentElement?.textContent.includes(${JSON.stringify(agent.name)}))`;
    await browser("wait", "--fn", `${pageHydrated} && ${open} !== undefined`);
    // A click that lands before the page hydrates opens nothing; try again until the DM opens.
    for (let attempt = 0; ; attempt += 1) {
      await evaluate(`(() => { ${open}?.setAttribute("data-e2e", "chat"); return true; })()`);
      await browser("click", '[data-e2e="chat"]').catch(() => undefined);
      await Bun.sleep(1500);
      if (await evaluate<boolean>(`location.pathname.includes("/dm/")`)) break;
      if (attempt === 8) throw new Error("the DM never opened");
    }
    await browser("wait", "--fn", `${title} !== undefined`);
    await Bun.sleep(2000);
    const page = `${origin}${await evaluate<string>("location.pathname")}`;
    const desktop = await evaluate<{ avatarWidth: number; clear: boolean; text: string }>(measure);
    await shots("desktop");
    expect(desktop.avatarWidth).toBeGreaterThan(20);
    expect(desktop.clear).toBe(true);
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${title} !== undefined`);
    await Bun.sleep(1500);
    const phone = await evaluate<{ avatarWidth: number; clear: boolean; text: string }>(measure);
    await shots("phone");
    expect(phone.avatarWidth).toBeGreaterThan(20);
    expect(phone.clear).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
