import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { COLLECT, startSandboxBrowserEnv } from "./helpers/artifact-sandbox-browser-env";
import { annotatePage, onePage } from "./helpers/artifact-sandbox-site";
import { until } from "./helpers/headless-chrome";

/**
 * The page runtime's annotation layer in a real browser, over the real `createPageBridge`: it
 * builds a stable selector for the element a person picks (ids, data attributes, positions), offers
 * a text selection as a quote, draws marks in its own overlay and reports which it
 * found, scrolls to one on request, and ignores forged messages. Chrome only (`COFORGE_E2E_CHROME`);
 * opt-in like every `.e2e.ts`:
 *   bun test ./test/artifact-page-annotate-browser.e2e.ts
 */
const env = await startSandboxBrowserEnv(["annotate"], ({ id }) => ({
  [id.annotate!]: onePage(annotatePage()),
}));
const { browser, linkFor, inApp } = env;
afterAll(() => env.stop());
const outputs = join(import.meta.dir, "../../../.amp/e2e/artifact-sandbox-files");

type Annotation = { kind: string; [key: string]: any };
type Rect = { x: number; y: number; right: number; top: number };

test("the runtime picks, selects, marks, focuses and ignores forged messages", async () => {
  const tab = await browser.open(inApp(await linkFor("annotate"), "annotate"), {
    everyDocument: COLLECT,
  });
  const events = () => tab.evaluate<Annotation[]>("window.__annotations");
  const fromPage = () =>
    tab.evaluate<Record<string, any>[]>(
      `window.__messages.filter((m) => m && m.page === "annotate")`,
    );
  const bridge = (call: string) => tab.evaluate(`window.__bridge.annotations.${call}`);
  const modeAcks = () =>
    tab.evaluate<boolean[]>(
      `window.__messages.filter((m) => m && m.method === "coforge/notifications/annotate-mode").map((m) => m.params.picking)`,
    );
  const setMode = async (picking: boolean) => {
    const seen = (await modeAcks()).length;
    await bridge(`configure({ picking: ${picking}, selecting: true, showMarks: true })`);
    await until(async () => (await modeAcks()).slice(seen).includes(picking), 8000);
  };
  const forgeUntilHandled = async (tag: string) => {
    await tab.evaluate(`window.__post("f", { forge: ${JSON.stringify(tag)} })`);
    await until(
      async () => (await tab.evaluate<string[]>("window.__errors")).includes(`forged:${tag}`),
      8000,
    );
    expect((await events()).filter((e) => e.kind === "selected" || e.kind === "activated")).toEqual(
      [],
    );
  };
  await until(async () => (await fromPage()).some((m) => m.ready), 15000);
  const rects = (await fromPage()).find((m) => m.rects)!.rects as Record<string, Rect>;
  const mouse = async (type: string, at: { x: number; y: number }, clickCount = 0) =>
    tab.command("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount });
  const click = async (at: { x: number; y: number }, clickCount = 1) => {
    await mouse("mouseMoved", at);
    await mouse("mousePressed", at, clickCount);
    await mouse("mouseReleased", at, clickCount);
  };
  const waitEvent = async (kind: string, from = 0) => {
    await until(async () => (await events()).slice(from).some((e) => e.kind === kind), 8000);
    return (await events()).slice(from).find((e) => e.kind === kind)!;
  };

  await setMode(false);
  await forgeUntilHandled("not-picking");
  await setMode(true);
  await forgeUntilHandled("picking-without-a-click");
  await setMode(false);

  await bridge(`setMarks([
    { id: "far", anchor: { type: "element", data: { selector: "main > div:last-child" } }, count: 1, label: "far" },
    { id: "title", anchor: { type: "element", data: { selector: "#title" } }, count: 2, label: "2 comments" },
    { id: "gone", anchor: { type: "element", data: { selector: "#gone" } }, count: 1, label: "gone" },
    { id: "quote", anchor: { type: "text", data: { quote: "beta on Friday.", prefix: "Ship the " } }, count: 1, label: "quote" },
    { id: "lost", anchor: { type: "text", data: { quote: "text that is not on the page at all" } }, count: 1, label: "lost" },
    { id: "bad", anchor: { type: "element", data: { selector: "][" } }, count: 1, label: "bad" },
  ])`);
  const found = await waitEvent("found");
  expect(found.ids).toEqual(["title", "quote", "far"]);
  await mkdir(outputs, { recursive: true });
  const shot = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "annotate-marks.png"), Buffer.from(shot.data, "base64"));

  const before = (await events()).length;
  await click({ x: rects.title!.right, y: rects.title!.top });
  expect(await waitEvent("activated", before)).toMatchObject({ id: "title" });

  const pickSelector = async (key: string) => {
    const from = (await events()).length;
    await setMode(true);
    await click(rects[key]!);
    const picked = await waitEvent("selected", from);
    expect(picked.anchor.type).toBe("element");
    return picked.anchor.data;
  };
  expect(await pickSelector("title")).toEqual({ selector: "#title", quote: "Launch plan" });
  expect(await pickSelector("intro")).toEqual({
    selector: "body > main > p",
    quote: "Ship the beta on Friday. Pricing is open for review.",
  });
  expect(await pickSelector("second")).toEqual({
    selector: "#list > li:nth-of-type(2)",
    quote: "Two",
  });
  expect(await pickSelector("buy")).toEqual({
    selector: 'button[data-testid="buy"]',
    quote: "Buy now",
  });
  expect(await pickSelector("odd")).toEqual({ selector: "body > main > span", quote: "Odd id" });

  const beforeEscape = (await events()).length;
  await setMode(true);
  await mouse("mouseMoved", rects.intro!);
  for (const type of ["keyDown", "keyUp"])
    await tab.command("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  await waitEvent("cancelled", beforeEscape);

  const beforeText = (await events()).length;
  await click(rects.intro!, 3);
  const selected = await waitEvent("selected", beforeText);
  expect(selected.anchor.type).toBe("text");
  expect(selected.anchor.data.quote).toBe("Ship the beta on Friday. Pricing is open for review.");

  const beforeDraft = (await events()).length;
  await bridge(`setDraft({ type: "text", data: { quote: "beta on Friday." } })`);
  await waitEvent("unselected", beforeDraft);
  await bridge(`setDraft(null)`);

  await bridge(`focus("far")`);
  await until(
    async () => ((await fromPage()).filter((m) => "scrollY" in m).at(-1)?.scrollY ?? 0) > 1000,
    8000,
  );
  const scrolled = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "annotate-focus.png"), Buffer.from(scrolled.data, "base64"));

  expect(
    (await events()).some((e) => e.kind === "selected" && e.anchor?.data?.quote === "forged"),
  ).toBe(false);
  await tab.close();
}, 90000);
