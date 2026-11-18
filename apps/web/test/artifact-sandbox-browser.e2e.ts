import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LINK_USED_NOTICE } from "#src/server/artifacts/artifact-sandbox-response.server";
import { COLLECT, startSandboxBrowserEnv } from "./helpers/artifact-sandbox-browser-env";
import { openPage } from "./helpers/artifact-sandbox-open";
import {
  frameWebRtcPage,
  hintsPage,
  multiFileSite,
  navigatorPage,
  onePage,
  otherLinkSite,
  probePage,
  storagePage,
} from "./helpers/artifact-sandbox-site";
import { until } from "./helpers/headless-chrome";

/**
 * A web-page artifact in a real browser, on an origin of its own (`a-<uuid>.localhost`): its
 * scripts run, its own files (style, script, module and its import, image, font, a fetch) load
 * from under its file token, and a link to another file opens in the frame; its origin's storage
 * works and no other artifact shares it; and no request it tries goes out — no fetch, XHR, beacon,
 * WebSocket, WebRTC, image, script, stylesheet, form, popup, nor moving the top page or its own
 * frame — framed in the app or opened in a tab. A ticket opens once. Everything the page tries is aimed at an "outside" server that counts what reaches it.
 * The public hosts its CSP names are pinned as text only (this test never reaches them).
 *
 * What the browser sends for a page's requests (`Sec-Fetch-*`) is recorded at the sandbox server
 * and written, with what the page saw, to `.artifacts/e2e/artifact-sandbox-files/summary.json` (and a
 * screenshot), the record of the run.
 *
 * The two ways out left open, resource hints and a WebRTC constructor taken from a frame the page
 * makes, are pinned by the last tests, so a browser change either way shows.
 *
 * Needs only Chrome (`COFORGE_E2E_CHROME`, else the macOS Google Chrome install; it resolves
 * `*.localhost` to loopback): the sandbox is the real `ArtifactSandbox` over a fake read of a few
 * pages, the app and the outside are tiny local servers, each on its own origin. Opt-in like every
 * `.e2e.ts`:
 *   bun test ./test/artifact-sandbox-browser.e2e.ts
 */

const NAMES = ["probe", "navigator", "hints", "multi", "frameRtc", "storageA", "storageB", "cross"];
const env = await startSandboxBrowserEnv(NAMES, async ({ out, tcp, stunPort, id }) => ({
  [id.probe!]: onePage(probePage(out, stunPort)),
  [id.navigator!]: onePage(navigatorPage(out)),
  [id.hints!]: onePage(hintsPage(tcp)),
  [id.multi!]: await multiFileSite(),
  [id.frameRtc!]: onePage(frameWebRtcPage(stunPort)),
  [id.storageA!]: onePage(storagePage("A")),
  [id.storageB!]: onePage(storagePage("B")),
}));
const { hits, seen, ID, SITES, sandbox, browser, linkFor, inApp } = env;
afterAll(() => env.stop());

type Probe = Record<string, string | boolean>;
type Tab = Awaited<ReturnType<typeof browser.open>>;

async function probeIn(url: string): Promise<Probe> {
  hits.length = 0;
  const tab = await browser.open(url, { everyDocument: COLLECT });
  try {
    const fromPage = `(window.__messages ?? []).filter((m) => m && m.jsonrpc === undefined)`;
    await until(async () => (await tab.evaluate<number>(`${fromPage}.length`)) > 0);
    await Bun.sleep(1000);
    return (await tab.evaluate<Probe[]>(fromPage))[0]!;
  } finally {
    await tab.close();
  }
}

test("framed in the app, the page's scripts run on its own origin and nothing reaches outside", async () => {
  const link = await linkFor("probe");
  const probe = await probeIn(inApp(link));
  expect(probe).toMatchObject({
    ran: true,
    origin: `http://a-${ID.probe}.localhost:${env.sandboxPort}`,
    storage: "allowed",
    webrtc: "threw",
  });
  expect(hits).toEqual([]);
});

test("opened in a tab of its own, the same holds", async () => {
  const probe = await probeIn(await linkFor("probe"));
  expect(probe).toMatchObject({ ran: true, storage: "allowed", webrtc: "threw" });
  expect(hits).toEqual([]);
});

test("storage works on the page's origin, survives a new ticket, and two artifacts do not share it", async () => {
  const messageOf = async (name: string) => {
    const tab = await browser.open(await linkFor(name), { everyDocument: COLLECT });
    try {
      await until(async () => (await tab.evaluate<number>("window.__messages.length")) > 0);
      return (await tab.evaluate<Record<string, unknown>[]>("window.__messages"))[0]!;
    } finally {
      await tab.close();
    }
  };
  expect((await messageOf("storageA")).before).toBeNull();
  expect((await messageOf("storageB")).before).toBeNull();
  expect((await messageOf("storageA")).before).toBe("A");
  expect((await messageOf("storageB")).before).toBe("B");
});

test("another origin cannot frame a link made for the app", async () => {
  hits.length = 0;
  const link = await linkFor("probe");
  const tab = await browser.open(`${env.out}/embed?src=${encodeURIComponent(link)}`, {
    everyDocument: COLLECT,
  });
  await Bun.sleep(1500);
  expect(await tab.evaluate<number>("window.__messages.length")).toBe(0);
  expect(hits).toEqual([]);
  await tab.close();
});

test("a ticket opens once: the second use is a page saying so, and the host is told", async () => {
  const link = await linkFor("probe");
  const first = await browser.open(link, { everyDocument: COLLECT });
  await until(async () => (await first.evaluate<number>("window.__messages.length")) > 0);
  await first.close();
  const tab = await browser.open(link);
  await until(async () =>
    (await tab.evaluate<string>("document.body.innerText")).includes(LINK_USED_NOTICE),
  );
  await tab.close();
  const framed = await browser.open(inApp(link));
  await until(async () => (await framed.evaluate<unknown>("window.__blocked")) !== undefined);
  expect(await framed.evaluate<unknown>("window.__blocked")).toEqual({
    state: "blocked",
    reason: "used",
    status: 401,
  });
  await framed.close();
});

test("a page cannot navigate its own frame away: it stays where it was and nothing reaches outside", async () => {
  hits.length = 0;
  const alive = async (url: string) => {
    const tab = await browser.open(url, { everyDocument: COLLECT });
    try {
      await until(
        async () =>
          (await tab.evaluate<Record<string, unknown>[]>("window.__messages")).some(
            (m) => m.page === "navigator",
          ),
        10000,
      );
    } finally {
      await tab.close();
    }
  };
  await alive(await linkFor("navigator"));
  await alive(inApp(await linkFor("navigator"), "navigator"));
  expect(hits).toEqual([]);
}, 20000);

test("the known gap: a resource hint still opens a connection", async () => {
  hits.length = 0;
  env.tcpState.connections = 0;
  const tab = await browser.open(inApp(await linkFor("hints"), "hints"));
  await until(async () => env.tcpState.connections > 0);
  expect(hits).toEqual([]);
  await tab.close();
});

/**
 * The known gap, pinned so a change shows: a same-origin frame the page makes (`about:blank`, which
 * `frame-src` does not govern) has its own global, with a WebRTC constructor the runtime never
 * removed. The page's CSP carries `webrtc 'block'` and the about:blank frame inherits it, but
 * Chrome 157.0.8103.51 does not enforce the directive, so a STUN or TURN request, whose server
 * name and credentials the page chooses, leaves for any host. When this test starts failing, the
 * browser started enforcing it (or the runtime closed the gap): flip it to expect no STUN.
 */
test("the known gap: a page that makes a frame takes a clean WebRTC constructor from it", async () => {
  hits.length = 0;
  const probe = (await probeIn(inApp(await linkFor("frameRtc"), "frameRtc"))) as Record<
    string,
    unknown
  >;
  expect(probe.page).toBe("frame-webrtc");
  expect(probe.peer).toBe("function");
  expect(hits).toContain("/stun");
  summary.frameWebRtc = { peer: probe.peer, reachedStun: hits.includes("/stun") };
});

const outputs = join(import.meta.dir, "../../../.artifacts/e2e/artifact-sandbox-files");
const summary: Record<string, unknown> = {};

type Message = Record<string, any>;
const messageOf = async (tab: Tab, page: string) => {
  await until(
    async () => await tab.evaluate<boolean>(`window.__messages.some((m) => m.page === "${page}")`),
    10000,
  );
  return (await tab.evaluate<Message[]>("window.__messages")).find((m) => m.page === page)!;
};

test("a page of several files: its own style, script, module, image, font and fetch load, and a link opens the next file in the frame", async () => {
  hits.length = 0;
  seen.length = 0;
  const framed = await browser.open(inApp(await linkFor("multi"), "multi"), {
    everyDocument: COLLECT,
  });
  const inFrame = await messageOf(framed, "index");
  await framed.close();
  expect(inFrame).toMatchObject({
    appRan: true,
    color: "rgb(1, 2, 3)",
    imageWidth: 1,
    font: "loaded",
    module: 42,
    fetched: 200,
  });

  const tab = await browser.open(await linkFor("multi"), { everyDocument: COLLECT });
  const index = await messageOf(tab, "index");
  expect(index).toMatchObject({ appRan: true, color: "rgb(1, 2, 3)", module: 42 });
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await tab.command("Input.dispatchMouseEvent", {
      type,
      x: index.link.x,
      y: index.link.y,
      button: "left",
      clickCount: 1,
    });
  const second = await messageOf(tab, "second");
  expect(second.color).toBe("rgb(1, 2, 3)");
  await mkdir(outputs, { recursive: true });
  const shot = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "second-page.png"), Buffer.from(shot.data, "base64"));
  await tab.close();
  expect(hits).toEqual([]);

  const first = (file: string) => seen.find((request) => request.file === file)!;
  expect(first("index.html")).toMatchObject({ dest: "iframe", mode: "navigate" });
  expect(first("second.html")).toMatchObject({ dest: "document", site: "same-origin" });
  expect(first("style.css")).toMatchObject({ dest: "style", site: "same-origin" });
  expect(first("app.js")).toMatchObject({ dest: "script", site: "same-origin" });
  expect(first("img/dot.png")).toMatchObject({ dest: "image", site: "same-origin" });
  expect(first("mod.js")).toMatchObject({ dest: "script", site: "same-origin" });
  expect(first("fonts/x.woff2")).toMatchObject({ dest: "font", site: "same-origin" });
  summary.seen = seen;
  summary.pageSaw = { index: { ...index, link: undefined }, second };
});

test("the page's CSP names its own prefix, the public hosts and the sandbox, and no wildcard", async () => {
  const { filesUrl, response } = await openPage(sandbox, await linkFor("multi"));
  const csp = response.headers.get("content-security-policy")!;
  for (const host of [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://esm.sh",
    "https://cdn.tailwindcss.com",
    "https://code.jquery.com",
    "https://cdn.plot.ly",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
  ])
    expect(csp).toContain(host);
  expect(csp).toContain(`connect-src ${filesUrl}`);
  expect(csp).toContain("sandbox allow-scripts allow-same-origin");
  expect(csp).not.toContain("*");
  summary.csp = csp;
});

test("a page cannot load a file from another artifact's origin", async () => {
  const { filesUrl: other } = await openPage(sandbox, await linkFor("multi"));
  SITES[ID.cross] = otherLinkSite(other);
  seen.length = 0;
  hits.length = 0;
  const tab = await browser.open(await linkFor("cross"), { everyDocument: COLLECT });
  const result = await messageOf(tab, "cross");
  await tab.close();
  expect(result.own).toBe(1);
  expect(result.other).toBe(0);
  expect(result.violations.some((v: string) => v.includes(other))).toBe(true);
  expect(seen.filter((request) => request.file === "style.css")).toEqual([]);
  expect(hits).toEqual([]);
  summary.crossArtifact = { own: result.own, other: result.other, violations: result.violations };
});

test("the run's record is written", async () => {
  await mkdir(outputs, { recursive: true });
  await Bun.write(join(outputs, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  expect(await Bun.file(join(outputs, "summary.json")).exists()).toBe(true);
});
