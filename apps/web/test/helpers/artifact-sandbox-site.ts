import { resolve } from "node:path";

/**
 * The files of the web pages `artifact-sandbox-browser.e2e.ts` serves: a page of several files
 * (style, script, module and its import, image, font, a second page) and a page that tries to
 * load files of another link. A site is its entry and its files, by path.
 */
export type Site = { entry: string; files: Record<string, Uint8Array | string> };

/** A one-pixel PNG. */
const DOT = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** A real font file the repository already holds (the docs theme's), so the browser decodes it. */
const FONT_FILE = resolve(
  import.meta.dir,
  "../../../docs/.vitepress/theme/fonts/inter-roman-extended.woff2",
);

export async function multiFileSite(): Promise<Site> {
  return {
    entry: "index.html",
    files: {
      "index.html": `<!doctype html><html><head><title>multi</title>
<link rel="stylesheet" href="style.css"><script src="app.js"></script>
<script type="module" src="mod.js"></script></head>
<body><p id="p">styled</p><img id="dot" src="img/dot.png"><a id="go" href="second.html">second page</a></body></html>`,
      "second.html": `<!doctype html><html><head><title>second</title><link rel="stylesheet" href="style.css"></head>
<body><p id="p">second page</p><script>
addEventListener("load", () => top.postMessage({ page: "second", color: getComputedStyle(document.getElementById("p")).color }, "*"));
</script></body></html>`,
      "style.css": `@font-face { font-family: Own; src: url(fonts/x.woff2); }
#p { color: rgb(1, 2, 3); font-family: Own; }`,
      "app.js": `window.appRan = true;
addEventListener("load", async () => {
  await document.fonts.load("16px Own").catch(() => {});
  const face = [...document.fonts].find((f) => f.family.replaceAll('"', "") === "Own");
  const box = document.getElementById("go").getBoundingClientRect();
  const fetched = await fetch("dep.js").then((r) => r.status).catch(() => "blocked");
  top.postMessage({
    fetched,
    page: "index",
    appRan: window.appRan,
    color: getComputedStyle(document.getElementById("p")).color,
    imageWidth: document.getElementById("dot").naturalWidth,
    font: face ? face.status : "none",
    module: window.modResult ?? null,
    link: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  }, "*");
});`,
      "mod.js": `import { answer } from "./dep.js";\nwindow.modResult = answer;`,
      "dep.js": "export const answer = 42;",
      "img/dot.png": DOT,
      "fonts/x.woff2": new Uint8Array(await Bun.file(FONT_FILE).arrayBuffer()),
    },
  };
}

/** A page that asks for a file under another link's prefix, and for one of its own as a control. */
export function otherLinkSite(otherPrefix: string): Site {
  return {
    entry: "index.html",
    files: {
      "index.html": `<!doctype html><html><head><script>
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.effectiveDirective + " " + e.blockedURI));
addEventListener("load", () => top.postMessage({
  page: "cross",
  own: document.getElementById("own").naturalWidth,
  other: document.getElementById("other").naturalWidth,
  violations,
}, "*"));
</script><link rel="stylesheet" href="${otherPrefix}style.css"><script src="${otherPrefix}app.js"></script></head>
<body><img id="own" src="img/dot.png"><img id="other" src="${otherPrefix}img/dot.png"></body></html>`,
      "img/dot.png": DOT,
    },
  };
}

/** A site of one `index.html`. */
export const onePage = (html: string): Site => ({
  entry: "index.html",
  files: { "index.html": html },
});

/** The bytes of a file by the sha256 the fake read gives it, `<artifact id>/<path>`. */
export function siteBytes(sites: Record<string, Site>, sha256: string): Uint8Array | null {
  const at = sha256.indexOf("/");
  const content = sites[sha256.slice(0, at)]?.files[sha256.slice(at + 1)];
  return content === undefined
    ? null
    : typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
}

/** One file of a site as the fake read lists it, or null when there is none. */
export function siteRow(sites: Record<string, Site>, artifactId: string, path: string) {
  const bytes = siteBytes(sites, `${artifactId}/${path}`);
  return bytes
    ? { path, sha256: `${artifactId}/${path}`, sizeBytes: bytes.byteLength, kind: "text" }
    : null;
}

/** Every way out the page tries, then what it could use, posted to the top page. `out` is the
 * "outside" server's URL every attempt aims at; `stunPort` a STUN server's port for WebRTC. */
export const probePage = (
  out: string,
  stunPort: number,
): string => `<!doctype html><html><head><title>probe</title></head><body><p>probe</p><script>
const OUT = ${JSON.stringify(out)};
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
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:" + ${stunPort} }] });
  pc.createDataChannel("x");
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
});
try { result.cookie = document.cookie; } catch (e) { result.cookie = "threw"; }
try { localStorage.setItem("k", "v"); result.storage = localStorage.getItem("k") === "v" ? "allowed" : "empty"; } catch (e) { result.storage = "threw"; }
result.origin = String(self.origin);
top.postMessage(result, "*");
</script></body></html>`;

/** A page that sends its own frame to `out/self`, and says whether it is still there after. */
export const navigatorPage = (out: string): string =>
  `<!doctype html><p>moving</p><script>
setTimeout(() => { location.href = ${JSON.stringify(`${out}/self`)}; }, 100);
setTimeout(() => top.postMessage({ page: "navigator", alive: true, href: location.href }, "*"), 1500);
</script>`;

/** A page that takes a clean WebRTC constructor from a frame it makes itself. */
export const frameWebRtcPage = (stunPort: number): string =>
  `<!doctype html><p>frames</p><script>
const result = { page: "frame-webrtc" };
try {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const Peer = frame.contentWindow.RTCPeerConnection;
  result.peer = typeof Peer;
  if (Peer) {
    const pc = new Peer({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] });
    pc.createDataChannel("x");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
  }
} catch (e) { result.peer = "threw"; }
setTimeout(() => top.postMessage(result, "*"), 500);
</script>`;

/** A page that writes, reads and reports what its origin's storage holds, and answers the bridge. */
export const storagePage = (name: string): string =>
  `<!doctype html><p>storage</p><script>
const before = localStorage.getItem("who");
localStorage.setItem("who", ${JSON.stringify(name)});
top.postMessage({ page: "storage", before, origin: location.origin }, "*");
</script>`;

export const bridgePage =
  (): string => `<!doctype html><html><head><title>bridge</title></head><body>
<p>Hello there, hello again</p><button id="copy">copy</button><button id="link">link</button><button id="comment">comment</button>
<script>
const post = (data) => top.postMessage({ page: "bridge", ...data }, "*");
const settle = (promise) => promise.then((value) => ({ ok: value }), (error) => ({ error: error.message }));
addEventListener("coforge:theme", (e) => post({ theme: e.detail.theme, attribute: document.documentElement.getAttribute("data-theme") }));
(async () => {
  const user = await coforge.use("user");
  const artifact = await coforge.use("artifact");
  const clipboard = await coforge.use("clipboard");
  const links = await coforge.use("links");
  const comments = await coforge.use("comments");
  post({
    ready: true,
    frozen: Object.isFrozen(user),
    user: await user.get(),
    artifact: await artifact.get(),
    missing: await coforge.use("fs"),
    coldCopy: await settle(clipboard.copy("cold")),
    theme: document.documentElement.getAttribute("data-theme"),
  });
  document.getElementById("copy").onclick = async () => post({ copy: await settle(clipboard.copy("copied text")) });
  document.getElementById("link").onclick = async () => post({ link: await settle(links.open("https://example.com/path")) });
  document.getElementById("comment").onclick = async () => post({ comment: await settle(comments.open({ name: "approve", label: "Approval" }, { draft: "Approve" })) });
  const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  post({ buttons: { copy: rect("copy"), link: rect("link"), comment: rect("comment") } });
  setTimeout(() => { throw new Error("boom"); }, 300);
})();
</script></body></html>`;

/** Resource hints (`tcp`), written and added by script: the one way out that stays open. */
export const hintsPage = (
  tcp: string,
): string => `<!doctype html><link rel="preconnect" href="${tcp}"><link rel="dns-prefetch" href="${tcp}"><script>
for (const rel of ["preconnect", "dns-prefetch"]) { const l = document.createElement("link"); l.rel = rel; l.href = ${JSON.stringify(tcp)}; document.head.append(l); }
</script><p>hints</p>`;

export const annotatePage = (): string => `<!doctype html><html><head><title>annotate</title>
<style>body{margin:0;font:16px sans-serif;height:3000px}main>*{position:absolute;margin:0}</style></head><body>
<main>
<h1 id="title" style="left:20px;top:20px">Launch plan</h1>
<p style="left:20px;top:80px">Ship the beta  on Friday.
   Pricing is open for review.</p>
<ul id="list" style="left:20px;top:160px;padding:0;list-style:none"><li>One</li><li>Two</li><li>Three</li></ul>
<button data-testid="buy" style="left:20px;top:300px">Buy now</button>
<span id="a:b" style="left:20px;top:360px">Odd id</span>
<div style="left:20px;top:2000px">Far below the fold</div>
</main>
<script>
const post = (data) => top.postMessage({ page: "annotate", ...data }, "*");
const at = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right, top: r.top + scrollY }; };
const rects = () => ({ title: at("#title"), intro: at("main > p"), second: at("#list li:nth-child(2)"), buy: at("button"), odd: at("main > span"), far: at("main > div:last-child") });
addEventListener("scroll", () => post({ scrollY }));
addEventListener("load", () => post({ ready: true, rects: rects() }));
const FORGED_ROUNDS = 5;
const forgedPick = { jsonrpc: "2.0", method: "coforge/notifications/annotate-selected", params: { type: "element", data: { selector: "h1", quote: "forged" }, rect: { top: 0, right: 1, bottom: 1, left: 0, width: 1, height: 1 } } };
const forgedActivation = { jsonrpc: "2.0", method: "coforge/notifications/annotate-activated", params: { id: "nope" } };
const forge = (tag) => {
  for (let round = 0; round < FORGED_ROUNDS; round += 1) {
    parent.postMessage(forgedPick, "*");
    parent.postMessage(forgedActivation, "*");
  }
  parent.postMessage({ jsonrpc: "2.0", method: "coforge/notifications/error", params: { message: "forged:" + tag } }, "*");
};
addEventListener("message", (event) => { if (event.data && typeof event.data.forge === "string") forge(event.data.forge); });
</script></body></html>`;
