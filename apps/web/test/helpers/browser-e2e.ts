import { createHash } from "node:crypto";

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
export function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * TanStack Start has hydrated the page: its SSR bootstrap (`$_TSR`) is marked hydrated, and
 * deleted once the stream has also ended. Server-rendered rows already satisfy the row waits,
 * and a click before hydration lands on inert HTML.
 */
export const pageHydrated = `(!window.$_TSR || window.$_TSR.hydrated === true)`;

/**
 * The local stack a browser E2E runs against: the Web service (`COFORGE_E2E_WEB_URL`),
 * `agent-browser`, and PostgreSQL (`DATABASE_URL`). Anything not local is refused, so a run never
 * seeds or resets a shared database.
 */
export function localBrowserE2e() {
  const origin = Bun.env.COFORGE_E2E_WEB_URL;
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required");
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  return { origin, browserPath, databaseUrl };
}

/** One agent-browser session: its commands, and a page expression read back as JSON. */
export function browserSession(browserPath: string, session: string) {
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  return { browser, evaluate };
}

/**
 * Waits for a page condition in one agent-browser session, failing with the condition and the
 * page text after 15 s. The wait child is killed on timeout: agent-browser serializes a
 * session's commands, so a pending `wait` would hold the page dump behind it until its own
 * 25 s limit. `run` is the session's command runner (`browserSession().browser`).
 */
export function pageWaiter(browserPath: string) {
  return (
    session: string,
    run: (command: string, ...args: string[]) => Promise<string>,
  ): ((condition: string) => Promise<void>) =>
    async (condition: string) => {
      const wait = Bun.spawn([browserPath, "--session", session, "wait", "--fn", condition], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const met = wait.exited.then(async (code) => {
        if (code !== 0)
          throw new Error(`Browser wait failed: ${await new Response(wait.stderr).text()}`);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 15_000);
      });
      try {
        if ((await Promise.race([met, timedOut])) === "timeout") {
          wait.kill("SIGKILL");
          const page = await run(
            "eval",
            `location.pathname + location.search + " | " + (document.querySelector("main")?.innerText ?? document.body.innerText ?? "").slice(0, 600)` +
              ` + " || scroll: " + JSON.stringify([...document.querySelectorAll('[data-scroll-restoration-id]')].map((el) => ({ id: el.getAttribute("data-scroll-restoration-id"), top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight })))`,
          ).catch((error: unknown) => String(error));
          throw new Error(`Timed out waiting for: ${condition}\nPage: ${page}`);
        }
      } finally {
        clearTimeout(timer);
        if (wait.exitCode === null) wait.kill("SIGKILL");
      }
    };
}

/** A page expression finding the open menu's item whose text is exactly `label`. */
export const menuItemNamed = (label: string) =>
  `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((item) => item.textContent.trim() === ${JSON.stringify(label)})`;

/** A page expression closing the open menu: a DOM-opened menu never held focus, so a page-level
 * Escape misses it; the keydown has to reach the menu itself. */
export const escapeOpenMenu = `document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}))`;

/**
 * Saves `messageId` in `channelId` through a second browser session — the "another tab" whose
 * save announces `saved.added.v1` to the first session's page. A raw row write would bypass
 * realtime and leave the first page's Saved list stale until its next full load.
 */
export async function saveMessageInOtherTab(options: {
  browserPath: string;
  session: string;
  origin: string;
  workspacePath: string;
  channelId: string;
  messageId: string;
}) {
  const { browserPath, session, origin, workspacePath, channelId, messageId } = options;
  const other = browserSession(browserPath, session);
  const wait = pageWaiter(browserPath)(session, other.browser);
  const row = `li[data-message-id="${messageId}"]`;
  await other.browser("open", `${origin}${workspacePath}/channel/${channelId}`);
  await wait(pageHydrated);
  await wait(`document.querySelector('${row}') !== null`);
  await other.browser("eval", `document.querySelector('${row} [aria-label="More"]').click()`);
  await wait(`${menuItemNamed("Save Message")} !== undefined`);
  await other.browser("eval", `${menuItemNamed("Save Message")}.click()`);
  await wait(`!document.querySelector('[role="menu"]')`);
}
