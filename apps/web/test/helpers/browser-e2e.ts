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
