import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e } from "./browser-e2e";

/**
 * The run both hide-usernames E2Es share: a Workspace of their own whose owner is the dev user
 * ("Dev Viewer"), with three members (Ada, Grace and Lin) whose usernames are
 * unmistakable, and the browser helpers. What it
 * created is removed afterwards and the dev user's name put back. Screenshots and `summary.json`
 * are written under `.amp/e2e/hide-usernames/<part>/`.
 */
export async function hideUsernamesRun(
  part: string,
  body: (run: HideUsernamesRun) => Promise<void>,
) {
  const { origin, browserPath, databaseUrl } = localBrowserE2e();
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(
    browserPath,
    `hide-usernames-${part}-${process.pid}`,
  );
  const artifacts = join(import.meta.dir, "../../../../.amp/e2e/hide-usernames", part);

  /** Waits for a page condition, failing with the condition and the page text after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText.slice(0, 600)`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  const checks: { name: string; passed: boolean }[] = [];
  const screenshots: string[] = [];

  const uid = crypto.randomUUID().slice(0, 4);
  const slug = `e2e-hide-usernames-${part}`;
  const prefix = `e2e-hide-${part}-`;
  const usernames = {
    ada: `${prefix}ada-zq7k${uid}`,
    grace: `${prefix}grace-zq7k${uid}`,
    lin: `${prefix}lin-zq7k${uid}`,
  };
  const handles = [DEV_BROWSER_USER.username, ...Object.values(usernames)];
  const memberIds: string[] = [];
  const viewerBefore = await db.user.findUnique({ where: { id: DEV_BROWSER_USER.id } });
  let workspaceId: string | undefined;
  try {
    // A leftover from an interrupted run starts over.
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await db.user.upsert({
      where: { id: DEV_BROWSER_USER.id },
      create: {
        id: DEV_BROWSER_USER.id,
        username: DEV_BROWSER_USER.username,
        displayName: "Dev Viewer",
      },
      update: { displayName: "Dev Viewer" },
    });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name: "Hidden Handles",
      userId: DEV_BROWSER_USER.id,
    });
    workspaceId = workspace.id;
    const people = [];
    for (const data of [
      { username: usernames.ada, displayName: "Ada Lovelace" },
      { username: usernames.grace, displayName: "Amazing Grace" },
      { username: usernames.lin, displayName: "Lindy" },
    ]) {
      const user = await db.user.create({ data });
      memberIds.push(user.id);
      people.push(user);
      await db.workspaceMembership.create({
        data: { workspaceId, userId: user.id, role: "member" },
      });
    }
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await body({
      db,
      browser,
      evaluate,
      waitFor,
      workspaceId,
      base: `${origin}/en/w/${slug}`,
      uid,
      people,
      showsNoUsername: (text) => handles.every((handle) => !text.includes(handle)),
      mainText: () => evaluate<string>(`document.querySelector("main")?.innerText ?? ""`),
      mainButton: (label) =>
        `[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`,
      hydrated: (element) =>
        `Object.keys(${element} ?? {}).some((key) => key.startsWith("__reactProps"))`,
      check: (name, passed) => {
        // Recorded before it is asserted, so `summary.json` shows what ran even on a failure.
        checks.push({ name, passed });
        expect(passed, name).toBe(true);
      },
      shoot: async (name) => {
        await browser("screenshot", join(artifacts, `${name}.png`));
        screenshots.push(`${name}.png`);
      },
    });
  } finally {
    await browser("close").catch(() => undefined);
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, "summary.json"),
      `${JSON.stringify(
        {
          test: `e2e-hide-usernames (${part})`,
          origin,
          workspace: slug,
          passed: checks.length > 0 && checks.every((entry) => entry.passed),
          checks,
          screenshots,
        },
        null,
        2,
      )}\n`,
    ).catch(() => undefined);
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: memberIds } } }).catch(() => {});
    if (viewerBefore)
      await db.user
        .update({
          where: { id: viewerBefore.id },
          data: { displayName: viewerBefore.displayName },
        })
        .catch(() => {});
    else await db.user.deleteMany({ where: { id: DEV_BROWSER_USER.id } }).catch(() => {});
    await db.$disconnect();
  }
}

export type HideUsernamesRun = {
  db: PrismaClient;
  browser: (...args: string[]) => Promise<string>;
  evaluate: <T>(expression: string) => Promise<T>;
  waitFor: (condition: string) => Promise<unknown>;
  workspaceId: string;
  /** The Workspace's URL, as `/en/w/<slug>`. */
  base: string;
  /** This run's id, part of every seeded handle. */
  uid: string;
  /** Ada, Grace and Lin, in that order. */
  people: { id: string }[];
  /** No seeded username appears in `text`, plain or as an `@mention`. */
  showsNoUsername: (text: string) => boolean;
  mainText: () => Promise<string>;
  /** A button of the page's main region, by its exact label. */
  mainButton: (label: string) => string;
  /** Whether React has hydrated `element`: before that a server-rendered button does nothing. */
  hydrated: (element: string) => string;
  check: (name: string, passed: boolean) => void;
  shoot: (name: string) => Promise<void>;
};
