/**
 * What the sandbox origin answers with (task #490). A link opens a fixed wrapper page of ours,
 * which frames the page itself, so the page is never a top-level document — not even in a tab of
 * its own. A top-level document is its own `top`, and sandboxing never stops a document moving
 * itself, so a page opened directly in a tab could send its reader anywhere; framed, `top` is the
 * wrapper, out of its reach.
 *
 * The page's headers let its own inline scripts and styles run; nothing else loads, and nothing
 * leaves:
 * - `sandbox allow-scripts`, as a CSP directive (and on the wrapper's iframe), makes it an opaque
 *   origin: no cookies, no storage, no same-origin access to anything. Without `allow-same-origin`,
 *   `allow-forms`, `allow-popups`, `allow-modals` or `allow-top-navigation`, it can neither submit
 *   a form, open a window, nor move the page that frames it.
 * - `default-src 'none'`, with only inline script and style and `data:` / `blob:` images, fonts
 *   and media, so it can neither load nor send anything: `connect-src`, `form-action`,
 *   `frame-src` and the rest are closed. Libraries and images are inlined by whoever writes it.
 * - `frame-ancestors`: the wrapper's origin and the app the link was made for.
 * - Its first script removes WebRTC, which CSP does not close in Chrome (`withWebRtcOff`).
 *
 * A document may always navigate its own frame, and no header of the page's own forbids it. The
 * wrapper's does: its `frame-src` admits only the sandbox origin, which a navigation of its frame
 * is checked against, so the page cannot send its frame (and what it puts in the URL) elsewhere.
 * The wrapper then shows a notice in the frame's place (`sandboxWrapper`).
 */
export function sandboxPageHeaders(input: { sandboxOrigin: string; appOrigin: string }): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "sandbox allow-scripts",
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "font-src data:",
      "media-src data: blob:",
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
 * The wrapper a link opens: the page in a full-size sandboxed frame, and a few lines of our own
 * script that replace the frame with a notice once it loads a second time — the page tried to
 * navigate it, which `frame-src` refused. It is framed by the application only (whose frame must
 * leave it its own origin: `sandbox="allow-scripts allow-same-origin"` or no `sandbox`), or opened
 * in a tab.
 */
export function sandboxWrapper(input: {
  pagePath: string;
  sandboxOrigin: string;
  appOrigin: string;
}): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>CoForge</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}p{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#555}</style>
</head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${input.pagePath}"></iframe>
<script nonce="${nonce}">(()=>{const f=document.querySelector("iframe");let n=0;f.addEventListener("load",()=>{if(++n<2)return;f.remove();const p=document.createElement("p");p.textContent=${JSON.stringify(NAVIGATED_NOTICE)};document.body.append(p);});})();</script>
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
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), display-capture=()",
} as const;
