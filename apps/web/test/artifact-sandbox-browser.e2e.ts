import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { NAVIGATED_NOTICE } from "#src/server/artifacts/artifact-sandbox-response.server";
import {
  multiFileSite,
  onePage,
  otherLinkSite,
  siteBytes,
  siteRow,
  type Site,
} from "./helpers/artifact-sandbox-site";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * A web-page artifact in a real browser (task #490): its scripts run, its own files (style,
 * script, module and its import, image, font) load from under its link, and a link to another
 * file opens in the frame; and no request it tries goes out — no fetch, XHR, beacon, WebSocket,
 * WebRTC, image, script, stylesheet, form, popup, nor moving the top page — framed in the app or
 * opened in a tab. It reads no cookie and no storage, and no other origin can frame it.
 * Everything it tries is aimed at an "outside" server that counts what reaches it. The public
 * hosts its CSP names are pinned as text only (this test never reaches them); a page cannot load
 * a file of another link, whose prefix its CSP does not name.
 *
 * What the browser sends for a page's requests from its opaque frame (`Sec-Fetch-*`, `Origin`) is
 * recorded at the sandbox server and written, with what the page saw, to
 * `.amp/e2e/artifact-sandbox-files/summary.json` (and a screenshot), the record of the run.
 *
 * Nor can it navigate its own frame away, which no header of its own forbids: the wrapper's
 * `frame-src` stops the navigation, and the wrapper puts a notice in the frame's place.
 *
 * The one way out left open, resource hints (a DNS lookup and a TCP connection, no request), is
 * pinned by the last test, so a browser change either way shows.
 *
 * Needs only Chrome (`COFORGE_E2E_CHROME`, else the macOS Google Chrome install): the sandbox is
 * the real `ArtifactSandbox` over a fake read of one page, the app and the outside are tiny local
 * servers, each on its own origin. Opt-in like every `.e2e.ts`:
 *   bun test ./test/artifact-sandbox-browser.e2e.ts
 */
const chrome = chromePath();
if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");

const hits: string[] = [];
const outside = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
    if (url.pathname === "/embed") return framing(url.searchParams.get("src")!);
    hits.push(url.pathname);
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  },
});
const OUT = `http://127.0.0.1:${outside.port}`;
// A bare TCP listener: what a resource hint opens is a connection, not an HTTP request.
let tcpConnections = 0;
const tcp = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open: (socket) => {
      tcpConnections += 1;
      socket.end();
    },
    data: () => {},
  },
});
const TCP = `http://127.0.0.1:${tcp.port}`;
// A STUN server the page might reach over WebRTC, which CSP's fetch directives do not govern.
const stun = await Bun.udpSocket({
  hostname: "127.0.0.1",
  socket: { data: () => void hits.push("/stun") },
});

/** Every way out the page tries, then what it could read, posted to the top page. */
const PROBE = `<!doctype html><html><head><title>probe</title></head><body><p>probe</p><script>
const OUT = ${JSON.stringify(OUT)};
const result = { ran: true };
const attempt = (name, run) => { try { run(); result[name] = "tried"; } catch (e) { result[name] = "threw"; } };
attempt("fetch", () => fetch(OUT + "/fetch").catch(() => {}));
attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", OUT + "/xhr"); x.send(); });
attempt("beacon", () => navigator.sendBeacon(OUT + "/beacon", "x"));
attempt("websocket", () => new WebSocket(OUT.replace("http", "ws") + "/ws"));
attempt("image", () => { new Image().src = OUT + "/image"; });
attempt("script", () => { const s = document.createElement("script"); s.src = OUT + "/script.js"; document.head.append(s); });
attempt("style", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = OUT + "/style.css"; document.head.append(l); });
attempt("form", () => { const f = document.createElement("form"); f.method = "post"; f.action = OUT + "/form"; document.body.append(f); f.submit(); });
attempt("popup", () => window.open(OUT + "/popup"));
attempt("top", () => { top.location.href = OUT + "/top"; });
attempt("webrtc", () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:" + ${stun.port} }] });
  pc.createDataChannel("x");
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
});
try { result.cookie = document.cookie; } catch (e) { result.cookie = "threw"; }
try { localStorage.setItem("k", "v"); result.storage = "allowed"; } catch (e) { result.storage = "threw"; }
result.origin = String(self.origin);
top.postMessage(result, "*");
</script></body></html>`;

/** A page that sends its own frame elsewhere. */
const NAVIGATOR = `<!doctype html><p>moving</p><script>setTimeout(() => { location.href = ${JSON.stringify(
  `${OUT}/self`,
)}; }, 100);</script>`;

/** Resource hints, written and added by script: the one way out that stays open (below). */
const HINTS = `<!doctype html><link rel="preconnect" href="${TCP}"><link rel="dns-prefetch" href="${TCP}"><script>
for (const rel of ["preconnect", "dns-prefetch"]) { const l = document.createElement("link"); l.rel = rel; l.href = ${JSON.stringify(TCP)}; document.head.append(l); }
</script><p>hints</p>`;

const SITES: Record<string, Site> = {
  probe: onePage(PROBE),
  navigator: onePage(NAVIGATOR),
  hints: onePage(HINTS),
  multi: await multiFileSite(),
};
const bytesOf = (sha256: string) => siteBytes(SITES, sha256);
const rowOf = (artifactId: string, path: string) => siteRow(SITES, artifactId, path);

/** What the sandbox server was asked for a file of a page, and how (`Sec-Fetch-*`, `Origin`). */
type Seen = {
  ticket: string;
  file: string;
  dest: string | null;
  site: string | null;
  mode: string | null;
  origin: string | null;
};
const seen: Seen[] = [];

/** Runs first in each tab's top document: collects what frames post to it. */
const COLLECT = `window.__messages = []; addEventListener("message", (e) => window.__messages.push(e.data));`;

let sandboxServer: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Bun.serve>;
let sandbox: ArtifactSandbox;
let browser: Awaited<ReturnType<typeof launchHeadlessChrome>>;

beforeAll(async () => {
  // The app on `localhost`, the sandbox and the outside on `127.0.0.1` at ports of their own:
  // three origins, and the app and the sandbox on different hosts, as `link` requires.
  sandboxServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const match = /^\/a\/([^/]+)\/page\/(.+)$/.exec(new URL(request.url).pathname);
      const header = (name: string) => request.headers.get(name);
      if (match)
        seen.push({
          ticket: match[1]!,
          file: decodeURIComponent(match[2]!),
          dest: header("sec-fetch-dest"),
          site: header("sec-fetch-site"),
          mode: header("sec-fetch-mode"),
          origin: header("origin"),
        });
      return sandbox.serve(request);
    },
  });
  sandbox = new ArtifactSandbox({
    reads: {
      read: async (input: { artifactId: string }) => {
        const site = SITES[input.artifactId]!;
        return {
          artifact: {},
          version: { number: 1, entryPath: site.entry },
          files: Object.keys(site.files).map((path) => rowOf(input.artifactId, path)),
        } as never;
      },
      file: async (input: { artifactId: string; path: string }) =>
        rowOf(input.artifactId, input.path),
    },
    readBlob: async (_workspaceId, sha256) => bytesOf(sha256),
    origin: `http://127.0.0.1:${sandboxServer.port}`,
    secret: async () => "x".repeat(40),
    now: () => new Date(),
  });
  app = Bun.serve({
    port: 0,
    hostname: "localhost",
    fetch: (request) => framing(new URL(request.url).searchParams.get("src")!),
  });
  browser = await launchHeadlessChrome(chrome);
});

afterAll(async () => {
  await browser?.close();
  for (const server of [outside, sandboxServer, app]) server?.stop(true);
  tcp.stop(true);
  stun.close();
});

const appOrigin = () => `http://localhost:${app.port}`;
const linkFor = async (page: string, embedderOrigin = appOrigin()) =>
  (await sandbox.link({ workspaceId: "w", userId: "u", artifactId: page, embedderOrigin })).url;
const inApp = (link: string) => `${appOrigin()}/?src=${encodeURIComponent(link)}`;

type Probe = Record<string, string | boolean>;

async function probeIn(url: string): Promise<Probe> {
  hits.length = 0;
  const tab = await browser.open(url, { everyDocument: COLLECT });
  try {
    await until(async () => (await tab.evaluate<number>("window.__messages?.length ?? 0")) > 0);
    // Give anything that did leave time to arrive.
    await Bun.sleep(1000);
    return (await tab.evaluate<Probe[]>("window.__messages"))[0]!;
  } finally {
    await tab.close();
  }
}

test("framed in the app, the page's scripts run and nothing reaches outside", async () => {
  const probe = await probeIn(inApp(await linkFor("probe")));
  expect(probe).toMatchObject({ ran: true, origin: "null", storage: "threw", webrtc: "threw" });
  expect(probe.cookie === "" || probe.cookie === "threw").toBe(true);
  expect(hits).toEqual([]);
});

test("opened in a tab of its own, the same holds: the page is still framed", async () => {
  const probe = await probeIn(await linkFor("probe"));
  expect(probe).toMatchObject({ ran: true, origin: "null", storage: "threw", webrtc: "threw" });
  expect(hits).toEqual([]);
});

test("another origin cannot frame a link made for the app", async () => {
  hits.length = 0;
  const link = await linkFor("probe");
  const tab = await browser.open(`${OUT}/embed?src=${encodeURIComponent(link)}`, {
    everyDocument: COLLECT,
  });
  await Bun.sleep(1500);
  // A refused frame shows the browser's error page instead: the probe never ran to post.
  expect(await tab.evaluate<number>("window.__messages.length")).toBe(0);
  expect(hits).toEqual([]);
  await tab.close();
});

test("a page file is no document of its own, and no other origin may frame it", async () => {
  const page = `${await linkFor("probe")}/page/index.html`;
  // Opened as a top-level document: refused, nothing runs.
  hits.length = 0;
  const top = await browser.open(page, { everyDocument: COLLECT });
  await Bun.sleep(1000);
  expect(await top.evaluate<string>("document.body.innerText")).toContain("Not found");
  expect(await top.evaluate<number>("window.__messages.length")).toBe(0);
  await top.close();
  // Framed by a cross-site origin that is not the app (so the file is asked for as a frame, and
  // only `frame-ancestors`, naming the sandbox origin and the app, stops it).
  const third = Bun.serve({
    port: 0,
    hostname: "localhost",
    fetch: (request) => framing(new URL(request.url).searchParams.get("src")!),
  });
  try {
    const embedded = await browser.open(
      `http://localhost:${third.port}/?src=${encodeURIComponent(page)}`,
      { everyDocument: COLLECT },
    );
    await Bun.sleep(1500);
    expect(await embedded.evaluate<number>("window.__messages.length")).toBe(0);
    await embedded.close();
  } finally {
    third.stop(true);
  }
  expect(hits).toEqual([]);
});

/**
 * The accepted residual: a link followed inside the frame reaches a page file cross-site, as the
 * app framing one directly does, so the app's own code can frame one without the wrapper. The
 * page stays opaque and sandboxed with nothing reaching outside; it lacks only the wrapper's
 * `frame-src` guard on where it may send its frame.
 */
test("the app framing a page file directly leaves it opaque, with nothing reaching outside", async () => {
  const probe = await probeIn(inApp(`${await linkFor("probe")}/page/index.html`));
  expect(probe).toMatchObject({ ran: true, origin: "null", storage: "threw", webrtc: "threw" });
  expect(probe.cookie === "" || probe.cookie === "threw").toBe(true);
  expect(hits).toEqual([]);
});

test("a page cannot navigate its own frame away either: the wrapper shows a notice", async () => {
  // In a tab the wrapper is the top document, so its notice can be read.
  hits.length = 0;
  const tab = await browser.open(await linkFor("navigator"));
  await until(async () =>
    (await tab.evaluate<string>("document.body.innerText")).includes(NAVIGATED_NOTICE),
  );
  expect(hits).toEqual([]);
  await tab.close();
  // In the app the wrapper is another origin's frame; that nothing left is what shows.
  const framed = await browser.open(inApp(await linkFor("navigator")));
  await Bun.sleep(1500);
  expect(hits).toEqual([]);
  expect(await framed.evaluate<string>("location.href")).toStartWith(appOrigin());
  await framed.close();
}, 20000);

/**
 * The known gap, pinned so a change shows: a resource hint (`<link rel="preconnect">`, written in
 * the page or added by its script) makes Chrome resolve the host and open a TCP connection, which
 * no CSP directive or header stops. No HTTP request goes out, but the host learns the reader's
 * address and when the page was opened, and a page can spell data into a host name it resolves.
 * Accepted for now (task #490); when this test starts failing, the browser closed the gap.
 */
test("known gap: a resource hint still opens a connection", async () => {
  hits.length = 0;
  tcpConnections = 0;
  const tab = await browser.open(inApp(await linkFor("hints")));
  await until(async () => tcpConnections > 0);
  // Only a connection: nothing reached the HTTP outside.
  expect(hits).toEqual([]);
  await tab.close();
});

const outputs = join(import.meta.dir, "../../../.amp/e2e/artifact-sandbox-files");
const summary: Record<string, unknown> = {};

type Message = Record<string, any>;
const messageOf = async (tab: Awaited<ReturnType<typeof browser.open>>, page: string) => {
  await until(
    async () => await tab.evaluate<boolean>(`window.__messages.some((m) => m.page === "${page}")`),
    10000,
  );
  return (await tab.evaluate<Message[]>("window.__messages")).find((m) => m.page === page)!;
};

test("a page of several files: its own style, script, module, image and font load, and a link opens the next file in the frame", async () => {
  hits.length = 0;
  seen.length = 0;
  const link = await linkFor("multi");
  const ticket = link.slice(link.lastIndexOf("/") + 1);
  // Framed in the app, as the pane shows it.
  const framed = await browser.open(inApp(link), { everyDocument: COLLECT });
  const inFrame = await messageOf(framed, "index");
  await framed.close();
  expect(inFrame).toMatchObject({
    appRan: true,
    color: "rgb(1, 2, 3)",
    imageWidth: 1,
    font: "loaded",
    module: 42,
  });

  // In a tab of its own, where the wrapper is the top document: click the link to the next file.
  const tab = await browser.open(link, { everyDocument: COLLECT });
  const index = await messageOf(tab, "index");
  expect(index).toMatchObject({
    appRan: true,
    color: "rgb(1, 2, 3)",
    imageWidth: 1,
    font: "loaded",
    module: 42,
  });
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
  // Still the page's own frame: no notice, no new document.
  expect(await tab.evaluate<boolean>('document.querySelectorAll("iframe").length === 1')).toBe(
    true,
  );
  expect(await tab.evaluate<string>("document.body.innerText")).not.toContain(NAVIGATED_NOTICE);
  await mkdir(outputs, { recursive: true });
  const shot = await tab.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(outputs, "second-page.png"), Buffer.from(shot.data, "base64"));
  await tab.close();
  expect(hits).toEqual([]);

  // What the browser sent, from the wrapper's frame and from the page's opaque origin.
  const mine = seen.filter((request) => request.ticket === ticket);
  const first = (file: string) => mine.find((request) => request.file === file)!;
  expect(first("index.html")).toMatchObject({
    dest: "iframe",
    site: "same-origin",
    mode: "navigate",
  });
  expect(first("second.html")).toMatchObject({
    dest: "iframe",
    site: "cross-site",
    mode: "navigate",
  });
  expect(first("style.css")).toMatchObject({ dest: "style", site: "cross-site", mode: "no-cors" });
  expect(first("app.js")).toMatchObject({ dest: "script", site: "cross-site", mode: "no-cors" });
  expect(first("img/dot.png")).toMatchObject({
    dest: "image",
    site: "cross-site",
    mode: "no-cors",
  });
  // CORS from an opaque origin: `Origin: null`, answered for exactly that.
  expect(first("mod.js")).toMatchObject({
    dest: "script",
    site: "cross-site",
    mode: "cors",
    origin: "null",
  });
  expect(first("dep.js")).toMatchObject({ dest: "script", mode: "cors", origin: "null" });
  expect(first("fonts/x.woff2")).toMatchObject({
    dest: "font",
    site: "cross-site",
    mode: "cors",
    origin: "null",
  });
  summary.seen = mine.map(({ ticket: _ticket, ...request }) => request);
  summary.pageSaw = { index: { ...index, link: undefined }, second };
});

test("the page's CSP names its own prefix and the public hosts, and still no connection", async () => {
  const link = await linkFor("multi");
  const response = await sandbox.serve(
    new Request(`${link}/page/index.html`, {
      headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
    }),
  );
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
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain(`${link}/page/`);
  summary.csp = csp;
});

test("a page cannot load a file from another link's prefix", async () => {
  const other = await linkFor("multi");
  SITES.cross = otherLinkSite(`${other}/page/`);
  seen.length = 0;
  hits.length = 0;
  const tab = await browser.open(await linkFor("cross"), { everyDocument: COLLECT });
  const result = await messageOf(tab, "cross");
  await tab.close();
  expect(result.own).toBe(1);
  expect(result.other).toBe(0);
  expect(result.violations.some((v: string) => v.includes(`${other}/page/`))).toBe(true);
  // The browser never asked: nothing under the other link's ticket reached the sandbox.
  const otherTicket = other.slice(other.lastIndexOf("/") + 1);
  expect(seen.filter((request) => request.ticket === otherTicket)).toEqual([]);
  expect(hits).toEqual([]);
  summary.crossLink = { own: result.own, other: result.other, violations: result.violations };
});

test("the run's record is written", async () => {
  await mkdir(outputs, { recursive: true });
  await Bun.write(join(outputs, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  expect(await Bun.file(join(outputs, "summary.json")).exists()).toBe(true);
});

/** A page framing `src` the way the app's pane does: our wrapper is its own origin's page. */
function framing(src: string): Response {
  return new Response(
    `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts allow-same-origin" src="${src}"></iframe></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
