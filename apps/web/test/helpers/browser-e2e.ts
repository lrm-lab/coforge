import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
 * React has hydrated `element` — an expression resolving to one node or undefined. SSR markup
 * already satisfies DOM waits, and a control's handlers attach only at hydration, so a click or
 * scroll sent before then lands on inert HTML.
 */
export const hydratedElement = (element: string) =>
  `Object.keys(${element} ?? {}).some((key) => key.startsWith("__reactProps"))`;

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

/**
 * Init script for a desktop e2e on a headless Linux runner: with no input devices Chrome reports
 * `(hover: none)` and `(any-pointer: coarse)` there (headed Chrome and macOS headless report a
 * fine pointer), and product code takes its coarse-pointer layout — a members row's actions sit
 * behind a menu button instead of inline ones. This answers queries made of pointer and hover
 * features as a desktop mouse would; a query that also names a width, scheme or motion, and every
 * other feature, still comes from the real `matchMedia`.
 */
export const DESKTOP_POINTER_INIT = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const q = String(query);
    if (
      /(any-)?(pointer|hover)/.test(q) &&
      !/width|height|min-|max-|resolution|aspect|orientation|color|motion|scan|grid|update|overflow|display-mode|forced-colors|inverted-colors|prefers-/.test(q)
    ) {
      const matches = !/coarse|none/.test(q);
      return {
        matches,
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      };
    }
    return real(query);
  };
})();`;

/** Writes {@link DESKTOP_POINTER_INIT} under `directory` and returns its path for `--init-script`. */
export async function desktopPointerInitScript(directory: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, "desktop-pointer.js");
  await Bun.write(file, DESKTOP_POINTER_INIT);
  return file;
}

/** One agent-browser session: its commands, a page expression read back as JSON, and the DOM
 * wait/click helpers the e2e files share. */
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
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so callers pass a longer budget. agent-browser's own wait
   * caps at 25 s, so the budget goes through `--timeout` or a longer wait dies at 25. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition, "--timeout", String(ms)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  /** A page expression resolving to the last element whose trimmed text is exactly `text`. */
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  /** Clicks the element `byText` finds, failing if it went away between the wait and the click. */
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    const clicked = await browser(
      "eval",
      `(() => { const target = ${byText(selector, text)}; target?.click(); return Boolean(target); })()`,
    );
    if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
  }
  return { browser, evaluate, waitFor, byText, clickText };
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
  await wait(`${menuItemNamed("Save message")} !== undefined`);
  await other.browser("eval", `${menuItemNamed("Save message")}.click()`);
  await wait(`!document.querySelector('[role="menu"]')`);
}

/**
 * A DevTools protocol connection to the session's page whose URL contains `urlPart`. An
 * `Emulation.*` setting made through it holds while it stays open; `close` drops it.
 */
export async function pageDevtools(
  browser: (...args: string[]) => Promise<string>,
  urlPart: string,
) {
  const port = new URL((await browser("get", "cdp-url")).trim().replace(/^ws/, "http")).port;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === "page" && target.url.includes(urlPart));
  if (!page) throw new Error(`no page at ${urlPart}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  return {
    /** Sends one command and waits for its answer, failing with the protocol's error. */
    send: (method: string, params: object = {}) =>
      new Promise<void>((resolve, reject) => {
        const sent = ++id;
        const closed = () => reject(new Error(`${method}: the page's connection closed`));
        socket.addEventListener("close", closed, { once: true });
        socket.addEventListener("message", function answered(event) {
          const answer = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
          if (answer.id !== sent) return;
          socket.removeEventListener("message", answered);
          socket.removeEventListener("close", closed);
          if (answer.error) reject(new Error(`${method}: ${JSON.stringify(answer.error)}`));
          else resolve();
        });
        socket.send(JSON.stringify({ id: sent, method, params }));
      }),
    close: () => socket.close(),
  };
}

/**
 * Slows the page's CPU the way DevTools' Performance panel does (`rate` 1 is full speed), on the
 * session's page whose URL contains `urlPart`: a busy phone's timing, where something late on the
 * page (a fetch answering, a part mounting) lands while the reader is already pressing. `close`
 * drops the connection; the browser's own close ends the throttle.
 */
export async function cpuThrottle(
  browser: (...args: string[]) => Promise<string>,
  urlPart: string,
) {
  const devtools = await pageDevtools(browser, urlPart);
  return {
    set: (rate: number) => devtools.send("Emulation.setCPUThrottlingRate", { rate }),
    close: devtools.close,
  };
}
