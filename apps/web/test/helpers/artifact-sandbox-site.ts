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
  top.postMessage({
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

/** Every way out the page tries, then what it could read, posted to the top page. `out` is the
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
try { localStorage.setItem("k", "v"); result.storage = "allowed"; } catch (e) { result.storage = "threw"; }
result.origin = String(self.origin);
top.postMessage(result, "*");
</script></body></html>`;

/** A page that sends its own frame to `out/self`. */
export const navigatorPage = (out: string): string =>
  `<!doctype html><p>moving</p><script>setTimeout(() => { location.href = ${JSON.stringify(
    `${out}/self`,
  )}; }, 100);</script>`;

/** Resource hints (`tcp`), written and added by script: the one way out that stays open. */
export const hintsPage = (
  tcp: string,
): string => `<!doctype html><link rel="preconnect" href="${tcp}"><link rel="dns-prefetch" href="${tcp}"><script>
for (const rel of ["preconnect", "dns-prefetch"]) { const l = document.createElement("link"); l.rel = rel; l.href = ${JSON.stringify(tcp)}; document.head.append(l); }
</script><p>hints</p>`;
