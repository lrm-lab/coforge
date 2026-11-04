import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { NAVIGATED_NOTICE } from "#src/server/artifacts/artifact-sandbox-response.server";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * A web-page artifact in a real browser (task #490): its own inline scripts run, and nothing it
 * tries reaches anywhere — no fetch, XHR, beacon, WebSocket, WebRTC, image, script, stylesheet, form,
 * popup, nor moving the top page — framed in the app or opened in a tab of its own. It reads no
 * cookie and no storage, and an origin other than the one the link was made for cannot frame it.
 * Everything it tries is aimed at an "outside" server that counts what reaches it.
 *
 * Nor can it navigate its own frame away, which no header of its own forbids: the wrapper's
 * `frame-src` stops the navigation, and the wrapper puts a notice in the frame's place.
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

const PAGES: Record<string, Uint8Array> = {
  probe: new TextEncoder().encode(PROBE),
  navigator: new TextEncoder().encode(NAVIGATOR),
};

/** Runs first in each tab's top document: collects what frames post to it. */
const COLLECT = `window.__messages = []; addEventListener("message", (e) => window.__messages.push(e.data));`;

let sandboxServer: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Bun.serve>;
let sandbox: ArtifactSandbox;
let browser: Awaited<ReturnType<typeof launchHeadlessChrome>>;

beforeAll(async () => {
  // The sandbox and the app answer on `localhost` at ports of their own, the outside on
  // `127.0.0.1`: three origins.
  sandboxServer = Bun.serve({ port: 0, hostname: "localhost", fetch: (r) => sandbox.serve(r) });
  sandbox = new ArtifactSandbox({
    reads: {
      read: async (input: { artifactId: string }) =>
        ({
          artifact: { kind: "html" },
          version: { number: 1, entryPath: "index.html" },
          files: [{ path: "index.html", sha256: input.artifactId, sizeBytes: 1, kind: "html" }],
        }) as never,
    },
    readBlob: async (_workspaceId, sha256) => PAGES[sha256] ?? null,
    origin: `http://localhost:${sandboxServer.port}`,
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

test("the app cannot frame the page without the wrapper", async () => {
  hits.length = 0;
  const tab = await browser.open(inApp(`${await linkFor("probe")}/page`), {
    everyDocument: COLLECT,
  });
  await Bun.sleep(1500);
  expect(await tab.evaluate<number>("window.__messages.length")).toBe(0);
  expect(hits).toEqual([]);
  await tab.close();
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

/** A page framing `src` the way the app's pane does: our wrapper is its own origin's page. */
function framing(src: string): Response {
  return new Response(
    `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts allow-same-origin" src="${src}"></iframe></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
