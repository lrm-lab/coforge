
/**
 * What the sandbox origin answers with (task #490). A link opens a fixed wrapper page of ours,
 * which frames the page itself, so the page is never a top-level document — not even in a tab of
 * its own. A top-level document is its own `top`, and sandboxing never stops a document moving
 * itself, so a page opened directly in a tab could send its reader anywhere; framed, `top` is the
 * wrapper, out of its reach.
 *
 * The page's headers let its own inline scripts and styles run, let it load its own files (the
 * ones under its link's prefix), and stop it sending anything over HTTP, WebSocket or WebRTC:
 * - `sandbox allow-scripts`, as a CSP directive (and on the wrapper's iframe), makes it an opaque
 *   origin: no cookies, no storage, no same-origin access to anything. Without `allow-same-origin`,
 *   `allow-forms`, `allow-popups`, `allow-modals` or `allow-top-navigation`, it can neither submit
 *   a form, open a window, nor move the page that frames it.
 * - `default-src 'none'`, with only inline script and style, `data:` / `blob:` images, fonts and
 *   media, and the page's own files: `connect-src`, `form-action`, `frame-src`
 *   and the rest are closed, so no request leaves. Its own files are the link's prefix
 *   (`/a/<ticket>/page/`), so a page cannot load a file of another link or version.
 * - `frame-ancestors`: the wrapper's origin and the app the link was made for.
 * - Its first script removes WebRTC, which CSP does not close in Chrome (`withWebRtcOff`).
 *
 * A document may always navigate its own frame, and no header of the page's own forbids it. The
 * wrapper's does: its `frame-src` admits only the sandbox origin, which a navigation of its frame
 * is checked against, so the page cannot send its frame (and what it puts in the URL) elsewhere.
 * The wrapper then shows a notice in the frame's place (`sandboxWrapper`), told by the browser
 * that `frame-src` refused the navigation; a link to another file of the artifact is the sandbox
 * origin itself and passes.
 *
 * Known gap, accepted for now: a resource hint (`<link rel="preconnect">` or `dns-prefetch`,
 * written in the page or added by its script) still makes Chrome resolve any host and open a TCP
 * connection to it. No CSP directive or header closes that, and blocking it from script is easily
 * worked around. No HTTP request goes out, but the host learns the reader's address and when the
 * page was opened, and the page can spell data into the host names it resolves (its own link
 * included, which opens only that page for five minutes). Pinned by
 * `artifact-sandbox-browser.e2e.ts`; closed when a better isolation is at hand.
 */
export function sandboxPageHeaders(input: {
  sandboxOrigin: string;
  appOrigin: string;
  /** The link's own file prefix: `<sandbox origin>/a/<ticket>/page/` (or `/p/<token>/page/`). */
  filePrefix: string;
}): Headers {
  const own = input.filePrefix;
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "sandbox allow-scripts",
      "default-src 'none'",
      `script-src 'unsafe-inline' ${own}`,
      `style-src 'unsafe-inline' ${own}`,
      `img-src data: blob: ${own}`,
      `font-src data: ${own}`,
      `media-src data: blob: ${own}`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      // Where a browser enforces it; Chrome does not, hence `WEBRTC_OFF`.
      "webrtc 'block'",
      // Every ancestor is checked: the wrapper, and the app framing the wrapper. That the app does
      // not frame the page directly is `serve`'s `Sec-Fetch-Site` check.
      `frame-ancestors ${input.sandboxOrigin} ${input.appOrigin}`,
    ].join("; "),
    ...COMMON,
  });
}

/**
 * A file of the page that is not html (a stylesheet, script, image, font, media): its type from
 * its extension, never sniffed, and a policy that lets one opened on its own do nothing. A module
 * script and a font are fetched with CORS from the page's opaque origin (`Origin: null`), so the
 * answer admits that origin and no other.
 */
export function sandboxFileHeaders(contentType: string, length: number): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Access-Control-Allow-Origin": "null",
    ...COMMON,
  });
}

/**
 * The wrapper a link opens: the page's entry file in a full-size sandboxed frame, and a few lines
 * of our own script that replace the frame with a notice once the browser reports that `frame-src`
 * refused a navigation of it — the page tried to send its frame to another address. (Counting the
 * frame's loads would not do: following a link to another file of the page loads it again.) It is framed by the application only (whose frame must
 * leave it its own origin: `sandbox="allow-scripts allow-same-origin"` or no `sandbox`), or opened
 * in a tab.
 */
export function sandboxWrapper(input: {
  pagePath: string;
  sandboxOrigin: string;
  appOrigin: string;
}): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>CoForge</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}p{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#555}</style>
</head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${input.pagePath}"></iframe>
<script nonce="${nonce}">(()=>{const f=document.querySelector("iframe");document.addEventListener("securitypolicyviolation",(e)=>{if(!e.violatedDirective.startsWith("frame-src")||!f.isConnected)return;f.remove();const p=document.createElement("p");p.textContent=${JSON.stringify(NAVIGATED_NOTICE)};document.body.append(p);});})();</script>
</body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        `frame-src ${input.sandboxOrigin}`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${input.appOrigin}`,
      ].join("; "),
      // Opened in a tab, it keeps no handle on the window that opened it.
      "Cross-Origin-Opener-Policy": "same-origin",
      ...COMMON,
    },
  });
}

/**
 * WebRTC is the one way out CSP does not close in Chrome: an `RTCPeerConnection` sends STUN to
 * whatever server the page names, and Chrome does not enforce `webrtc 'block'`. So the page's
 * first script, before any of its own, removes the WebRTC constructors for good. The page cannot
 * fetch them again from another realm: a frame it makes is out of its reach (each sandboxed
 * document is an opaque origin of its own), and it can open no window and start no worker.
 */
const WEBRTC_OFF = `<script>(()=>{for(const n of ${JSON.stringify([
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCIceTransport",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
  "RTCDtlsTransport",
  "RTCSctpTransport",
  "RTCCertificate",
])})try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch{}})();</script>`;
const WEBRTC_OFF_BYTES = new TextEncoder().encode(WEBRTC_OFF);

/** The page's bytes with `WEBRTC_OFF` first: after a leading doctype (so the page keeps its
 * standards mode), else at the very start. */
export function withWebRtcOff(page: Uint8Array): Uint8Array<ArrayBuffer> {
  // `ignoreBOM` keeps a leading BOM in the text, so the match's length is its length in bytes.
  const head = new TextDecoder("utf-8", { ignoreBOM: true }).decode(page.subarray(0, 1024));
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(head)?.[0];
  const at = doctype ? new TextEncoder().encode(doctype).byteLength : 0;
  const out = new Uint8Array(page.byteLength + WEBRTC_OFF_BYTES.byteLength);
  out.set(page.subarray(0, at), 0);
  out.set(WEBRTC_OFF_BYTES, at);
  out.set(page.subarray(at), at + WEBRTC_OFF_BYTES.byteLength);
  return out;
}

/** Shown in the frame's place once the page navigated it. */
export const NAVIGATED_NOTICE =
  "这个网页试图打开别的地址，已拦下。 This page tried to go to another address and was stopped.";

/** A refusal: plain text that runs nothing, framed by no one. */
export function sandboxRefusal(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      ...COMMON,
    },
  });
}

const COMMON = {
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), display-capture=()",
} as const;
