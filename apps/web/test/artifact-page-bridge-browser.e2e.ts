import { afterAll, test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { COLLECT, startSandboxBrowserEnv } from "./helpers/artifact-sandbox-browser-env";
import { bridgePage, onePage } from "./helpers/artifact-sandbox-site";
import { until } from "./helpers/headless-chrome";

/**
 * The page runtime of a web-page artifact answers the host's bridge in a real browser: `user.get`,
 * `artifact.get`, the clipboard in a click, a confirmed link, the comment composer, theme, error
 * reports and find, over the real `createPageBridge` built for a tiny host page. Needs only Chrome
 * (`COFORGE_E2E_CHROME`); opt-in like every `.e2e.ts`:
 *   bun test ./test/artifact-page-bridge-browser.e2e.ts
 */
const env = await startSandboxBrowserEnv(["bridge"], ({ id }) => ({
  [id.bridge!]: onePage(bridgePage()),
}));
const { browser, linkFor, inApp, ID } = env;
afterAll(() => env.stop());
const outputs = join(import.meta.dir, "../../../.amp/e2e/artifact-sandbox-files");

test("the page runtime answers the bridge: who, which artifact, clipboard in a click, a confirmed link, the composer, theme, errors, find", async () => {
  const tab = await browser.open(inApp(await linkFor("bridge"), "bridge"), {
    everyDocument: COLLECT,
  });
  const messages = async () =>
    (await tab.evaluate<Record<string, any>[]>("window.__messages")).filter(
      (m) => m.page === "bridge",
    );
  const find = async (key: string) => {
    await until(async () => (await messages()).some((m) => key in m), 10000);
    return (await messages()).find((m) => key in m)!;
  };
  const ready = await find("ready");
  expect(ready).toMatchObject({
    frozen: true,
    user: { displayName: "Lin Xia", kind: "person" },
    artifact: { id: ID.bridge!, title: "Probe", version: 1, entryPath: "index.html" },
    missing: null,
    coldCopy: { error: "Copy needs a click in the page" },
    theme: "light",
  });
  const { buttons } = await find("buttons");
  const click = async (at: { x: number; y: number }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await tab.command("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
  };

  await click(buttons.copy);
  expect((await find("copy")).copy).toEqual({ ok: { copied: true } });
  expect(await tab.evaluate<string>("window.__copied")).toBe("copied text");

  await click(buttons.link);
  await until(
    async () => (await tab.evaluate<string | undefined>("window.__confirmUrl")) !== undefined,
  );
  expect(await tab.evaluate<string>("window.__confirmUrl")).toBe("https://example.com/path");
  expect(await tab.evaluate<unknown>("window.__opened")).toBeUndefined();
  await tab.evaluate("window.__decide(true)");
  expect((await find("link")).link).toEqual({ ok: {} });
  expect(await tab.evaluate<string>("window.__opened")).toBe("https://example.com/path");

  await click(buttons.comment);
  expect((await find("comment")).comment).toEqual({ ok: { opened: true } });
  expect(await tab.evaluate<unknown>("window.__composer")).toEqual({ body: "Approve" });

  await until(async () => (await tab.evaluate<string[]>("window.__errors")).length > 0);
  expect((await tab.evaluate<string[]>("window.__errors"))[0]).toContain("boom");

  await tab.evaluate('window.__theme = "dark"; window.__bridge.notifyTheme()');
  await until(async () =>
    (await messages()).some((m) => m.attribute === "dark" && m.theme === "dark"),
  );

  await tab.evaluate('window.__bridge.find({ query: "hello", step: 0 })');
  await until(
    async () => (await tab.evaluate<{ total: number } | undefined>("window.__find"))?.total === 2,
  );
  await tab.evaluate('window.__bridge.find({ query: "hello", step: 1 })');
  await until(async () => (await tab.evaluate<{ active: number }>("window.__find")).active === 2);
  await mkdir(outputs, { recursive: true });
  const shot = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "bridge-find.png"), Buffer.from(shot.data, "base64"));
  await tab.close();
}, 40000);
