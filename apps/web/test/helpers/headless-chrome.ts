import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A headless Chrome driven over the DevTools protocol, with no package: launch it, open a page,
 * evaluate an expression in it. For a browser e2e that needs a real browser's enforcement (CSP,
 * iframe sandboxing) but none of the local stack. `COFORGE_E2E_CHROME` names the binary, else the
 * macOS Google Chrome install; `COFORGE_E2E_CHROME_ARGS` adds flags.
 */
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromePath(): string | null {
  const path = Bun.env.COFORGE_E2E_CHROME ?? DEFAULT_CHROME;
  return Bun.file(path).size > 0 ? path : null;
}

export async function launchHeadlessChrome(path: string) {
  const profile = await mkdtemp(join(tmpdir(), "coforge-chrome-"));
  const child = Bun.spawn(
    [
      path,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Extra flags from the host, e.g. `--no-sandbox` on a Linux runner without unprivileged user
      // namespaces (.github/workflows/web-e2e.yml).
      ...(Bun.env.COFORGE_E2E_CHROME_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const endpoint = await debuggerEndpoint(profile);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  function send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) =>
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  /** A new tab at `url`, and an evaluator in its top document. `everyDocument` runs first in
   * every document the tab loads, frames included (`Page.addScriptToEvaluateOnNewDocument`). */
  async function open(url: string, options: { everyDocument?: string } = {}) {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.enable", {}, sessionId);
    if (options.everyDocument)
      await send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: options.everyDocument },
        sessionId,
      );
    await send("Page.navigate", { url }, sessionId);
    async function evaluate<T>(expression: string): Promise<T> {
      const { result, exceptionDetails } = await send<{
        result: { value?: T };
        exceptionDetails?: { text: string };
      }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (exceptionDetails) throw new Error(exceptionDetails.text);
      return result.value as T;
    }
    return { evaluate, close: () => send("Target.closeTarget", { targetId }) };
  }

  async function close() {
    socket.close();
    child.kill();
    await child.exited;
    await rm(profile, { recursive: true, force: true });
  }
  return { open, close };
}

/** Chrome writes its port and browser path to `DevToolsActivePort` once it listens. */
async function debuggerEndpoint(profile: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, path] = text.trim().split("\n");
    if (port && path) return `ws://127.0.0.1:${port}${path}`;
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not start its debugger");
}

/** Waits until `check` holds, or fails after `ms`. */
export async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}
