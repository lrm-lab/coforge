import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { COLLECT, startSandboxBrowserEnv } from "./helpers/artifact-sandbox-browser-env";
import { dataPage } from "./helpers/artifact-page-data-site";
import { until } from "./helpers/headless-chrome";

/**
 * A web page's shared data and asset library in a real browser: two viewers' frames of the same
 * artifact over the real `createPageBridge` and page runtime. One frame's `set` shows in both
 * frames' `watch` at once; the host asks before the first write (and not again for that frame),
 * and before an upload or a removal; an asset loads by the URL the runtime composes, under the
 * page's own origin. Needs only Chrome (`COFORGE_E2E_CHROME`); opt-in like every `.e2e.ts`:
 *   bun test ./test/artifact-page-data-browser.e2e.ts
 */
const env = await startSandboxBrowserEnv(["data"], ({ id }) => ({ [id.data!]: dataPage() }), {
  assetFiles: { "hello.txt": "asset-source.txt" },
});
const { browser, linkFor, inApp, ID } = env;
afterAll(() => env.stop());
const outputs = join(import.meta.dir, "../../../.amp/e2e/artifact-sandbox-files");

type Message = Record<string, any>;

test("a set in one viewer's frame shows in every frame's watch; writes, uploads and removals are confirmed", async () => {
  const tab = await browser.open(inApp(await linkFor("data"), "data", await linkFor("data")), {
    everyDocument: COLLECT,
  });
  const messages = async () =>
    (await tab.evaluate<Message[]>("window.__messages")).filter((m) => m.page === "data");
  const from = async (role: string, key: string, timeout = 10000) => {
    await until(async () => (await messages()).some((m) => m.role === role && key in m), timeout);
    return (await messages()).filter((m) => m.role === role && key in m).at(-1)!;
  };
  const tell = (id: string, message: object) =>
    tab.evaluate(`window.__post(${JSON.stringify(id)}, ${JSON.stringify(message)})`);
  const decide = async (allowed: boolean, kind: string) => {
    await until(
      async () => (await tab.evaluate<string | undefined>("window.__confirm?.kind")) === kind,
    );
    await tab.evaluate(`window.__decide(${allowed}); window.__confirm = undefined`);
  };

  const ready = await from("first", "ready");
  expect(ready).toMatchObject({
    frozen: true,
    db: ["batch", "delete", "get", "query", "set", "update", "watch"],
    assets: ["delete", "list", "upload", "url"],
  });
  await from("second", "ready");
  expect((await from("first", "watch")).watch).toEqual([]);
  expect((await from("second", "watch")).watch).toEqual([]);

  await tell("f", { cmd: "set", id: "a", data: { text: "hello", n: 1 } });
  await decide(true, "data");
  expect((await from("first", "set")).set).toEqual({
    ok: { collection: "notes", id: "a", version: 1 },
  });
  await until(async () =>
    (await messages()).some((m) => m.role === "second" && m.watch?.join() === "hello"),
  );
  expect(await tab.evaluate<unknown[]>("window.__confirms.map((c) => c.paths)")).toEqual([
    ["notes/a"],
  ]);

  await tell("f", {
    cmd: "batch",
    ops: [{ op: "set", collection: "notes", id: "b", data: { text: "world", n: 2 } }],
  });
  await from("first", "batch");
  await until(async () =>
    (await messages()).some((m) => m.role === "second" && m.watch?.join() === "hello,world"),
  );
  expect(await tab.evaluate<number>("window.__confirms.length")).toBe(1);

  await tell("f2", { cmd: "set", id: "c", data: { text: "from second", n: 3 } });
  await until(async () =>
    (await messages()).some(
      (m) => m.role === "first" && m.watch?.join() === "hello,world,from second",
    ),
  );
  expect(await tab.evaluate<number>("window.__confirms.length")).toBe(1);

  await tell("f", { cmd: "upload", name: "hello.txt", text: "from the library" });
  await decide(false, "upload");
  expect((await from("first", "upload")).upload).toEqual({ error: "Declined" });
  await tell("f", { cmd: "upload", name: "hello.txt", text: "from the library" });
  await decide(true, "upload");
  expect((await from("first", "upload")).upload.ok).toMatchObject({ name: "hello.txt" });
  await tell("f", { cmd: "list" });
  expect((await from("first", "list")).list.ok.map((a: Message) => a.name)).toEqual(["hello.txt"]);

  await tell("f", { cmd: "fetchAsset", name: "hello.txt" });
  const fetched = (await from("first", "fetchAsset")).fetchAsset.ok;
  expect(fetched).toMatchObject({
    status: 200,
    text: "from the library",
    type: "text/plain; charset=utf-8",
  });
  expect(fetched.url).toContain(`a-${ID.data}.localhost`);
  expect(fetched.url).toContain("/_a/");
  await tell("f", { cmd: "fetchOther" });
  expect((await from("first", "fetchOther")).fetchOther).toEqual({ ok: 404 });

  await tell("f2", { cmd: "delete", name: "hello.txt" });
  expect((await from("second", "delete")).delete).toEqual({ error: "Not allowed" });
  await tell("f", { cmd: "delete", name: "hello.txt" });
  await decide(true, "delete");
  expect((await from("first", "delete")).delete).toEqual({ ok: { deleted: true } });

  await mkdir(outputs, { recursive: true });
  const shot = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "page-data.png"), Buffer.from(shot.data, "base64"));
  await tab.close();
}, 60000);
