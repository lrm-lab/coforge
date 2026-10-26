import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { RUNTIME_AUTH_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getRuntimeAuthCapabilityLease } from "#src/server/computers/runtime-auth-capability.server";

/** Opt-in E2E for a runtime popover's account band (task #196) on the private stack the other
 * browser E2Es use (built Web with development skip-auth, PostgreSQL, Redis, ego-browser). No
 * daemon runs and nothing is signed in or out: the login states are seeded on the Computer.
 * Screenshots: .amp/e2e/runtime-account-band/. */
const databaseUrl = Bun.env.DATABASE_URL;
const web = Bun.env.COFORGE_E2E_WEB_URL;
const browser = Bun.which("ego-browser");
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
if (!web || new URL(web).hostname !== "127.0.0.1")
  throw new Error("COFORGE_E2E_WEB_URL must target local Web");
if (!browser) throw new Error("ego-browser is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const suffix = String(process.pid);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/runtime-account-band");
const space = "coforge-chores task196 runtime account band";
const runtimes = [
  ["claude-code", "Claude Code", "max"],
  ["codex", "Codex CLI", "pro"],
  ["kiro", "Kiro CLI", "KIRO POWER"],
] as const;
const computerIds: Record<"in" | "out", string> = { in: "", out: "" };
let slug = "";
let browserPassed = false;

async function runBrowser(script: string) {
  const child = Bun.spawn([browser!, "nodejs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(script);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  slug = membership.workspace.slug;
  for (const state of ["in", "out"] as const) {
    const computer = await db.computer.create({
      data: {
        ownerId: DEV_BROWSER_USER.id,
        machineId: `account-band-${state}-${suffix}`,
        name: `account-band-${state}-${suffix}`,
        computerVersion: "1.0.53",
        platform: "linux",
        runtimeAuth: {
          collectedAtMs: Date.now(),
          runtimes: Object.fromEntries(
            runtimes.map(([provider, , plan]) => [
              provider,
              state === "in"
                ? {
                    provider,
                    state: "logged_in",
                    account: { maskedLabel: "f***@example.com", planLabel: plan },
                  }
                : { provider, state: "logged_out" },
            ]),
          ),
        },
      },
    });
    computerIds[state] = computer.id;
    await db.workspaceComputer.create({
      data: { workspaceId: membership.workspaceId, computerId: computer.id },
    });
    for (const [provider, displayName] of runtimes)
      await db.computerRuntime.create({
        data: {
          workspaceId: membership.workspaceId,
          computerId: computer.id,
          provider,
          version: "1.0.0",
          displayName,
        },
      });
    const scope = { workspaceId: membership.workspaceId, computerId: computer.id };
    await getComputerStatusCache().put(scope, true);
    await getRuntimeAuthCapabilityLease().record(scope.workspaceId, scope.computerId, [
      RUNTIME_AUTH_CAPABILITY,
    ]);
  }
  await mkdir(artifacts, { recursive: true });
});

afterAll(async () => {
  for (const id of Object.values(computerIds)) if (id) await db.computer.delete({ where: { id } });
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
  // A phone with its browser bars and the page header: less room than the popover's content.
  [390, 400],
] as const)
  test(`${width}x${height}: every runtime's account action is the popover's last band, fully on screen`, async () => {
    browserPassed = false;
    for (const state of ["in", "out"] as const) {
      const action = state === "in" ? "Sign Out" : "Sign In";
      for (const [provider, displayName] of runtimes) {
        const name = `${width}x${height}-${provider}-${state}`;
        const out = await runBrowser(`
          const task = await taskSpace(${JSON.stringify(space)});
          const page = task.page("p1");
          await page.cdp("Emulation.setDeviceMetricsOverride", { width: ${width}, height: ${height}, deviceScaleFactor: 2, mobile: ${width < 640} });
          await page.goto(${JSON.stringify(`${web}/en/w/${slug}/computer/${computerIds[state]}`)});
          await page.waitForSelector('li button[aria-label^=${JSON.stringify(displayName)}]', { timeout: 30000 });
          await page.click('li button[aria-label^=${JSON.stringify(displayName)}]');
          await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
          await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5000 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: ${JSON.stringify(join(artifacts, `${name}.png`))} });
          console.log(JSON.stringify(await page.evaluate((label) => {
            const dialog = document.querySelector('[role="dialog"]');
            const popover = dialog.parentElement;
            const button = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
            if (!button) return { found: false };
            const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
            // The band holding the action: a direct child of a ruled (divide-y) list.
            const band = button.closest(".divide-y > *");
            return {
              found: true,
              last: !band.nextElementSibling && dialog.firstElementChild.lastElementChild.contains(band),
              alone: !band.querySelector("input"),
              button: box(button),
              popover: box(popover),
              viewport: { width: innerWidth, height: innerHeight },
            };
          }, ${JSON.stringify(action)})));
        `);
        const at = JSON.parse(
          out
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .at(-1)!,
        );
        expect({ name, found: at.found, last: at.last, alone: at.alone }).toEqual({
          name,
          found: true,
          last: true,
          alone: true,
        });
        // On screen and inside the popover's own box, not cut by its edge or the viewport's.
        expect(at.button.top).toBeGreaterThanOrEqual(Math.max(0, at.popover.top));
        expect(at.button.bottom).toBeLessThanOrEqual(
          Math.min(at.viewport.height, at.popover.bottom),
        );
        expect(at.button.left).toBeGreaterThanOrEqual(Math.max(0, at.popover.left));
        expect(at.button.right).toBeLessThanOrEqual(Math.min(at.viewport.width, at.popover.right));
      }
    }
    browserPassed = true;
  }, 180_000);
