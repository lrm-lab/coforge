import { withPublicCdns } from "./artifact-sandbox-cdns.server";
import { PAGE_RUNTIME_PATH, pageRuntimeSource } from "./artifact-page-runtime.server";

const PAGE_SANDBOX = "sandbox allow-scripts allow-same-origin";

export function sandboxPageHeaders(input: {
  pageOrigin: string;
  frameAncestor: string;
  filePrefix: string;
  assetPrefix?: string;
}): Headers {
  const own = input.filePrefix;
  const loaded = input.assetPrefix ? `${own} ${input.assetPrefix}` : own;
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": withPublicCdns([
      PAGE_SANDBOX,
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' blob: ${input.pageOrigin}${PAGE_RUNTIME_PATH} ${own}`,
      `style-src 'unsafe-inline' ${own}`,
      `img-src data: blob: ${loaded}`,
      `font-src data: ${own}`,
      `media-src data: blob: ${loaded}`,
      `connect-src ${loaded}`,
      `worker-src blob: ${own}`,
      "child-src blob:",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      `frame-ancestors ${input.frameAncestor}`,
    ]).join("; "),
    ...COMMON,
  });
}

export function sandboxFileHeaders(
  contentType: string,
  length: number,
  cacheControl: string,
  policy = "sandbox; default-src 'none'",
): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Content-Security-Policy": policy,
    ...COMMON,
    "Cache-Control": cacheControl,
  });
}

export function sandboxAssetResponse(
  method: string,
  contentType: string,
  bytes: Uint8Array,
): Response {
  const headers = sandboxFileHeaders(contentType, bytes.byteLength, "private, no-cache");
  return new Response(method === "HEAD" ? null : new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers,
  });
}

export function sandboxRuntimeResponse(method: string): Response {
  const source = new TextEncoder().encode(pageRuntimeSource());
  return new Response(method === "HEAD" ? null : source, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": String(source.byteLength),
      "Content-Security-Policy": "sandbox; default-src 'none'",
      ...COMMON,
    },
  });
}

export const LINK_USED_NOTICE =
  "这个链接已经用过了，请在 CoForge 里重新打开。 This link was used. Open it again from CoForge.";
export const LINK_EXPIRED_NOTICE =
  "这个链接已过期，请在 CoForge 里重新打开。 This link has expired. Open it again from CoForge.";

export type FrameBlock = { reason: "used" | "expired"; status: number };

export function sandboxBlockedPage(input: {
  method: string;
  block: FrameBlock;
  hostOrigin: string;
}): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const notice = input.block.reason === "used" ? LINK_USED_NOTICE : LINK_EXPIRED_NOTICE;
  const status = {
    jsonrpc: "2.0",
    method: "coforge/notifications/frame-status",
    params: { state: "blocked", reason: input.block.reason, status: input.block.status },
  };
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>CoForge</title>
<style nonce="${nonce}">body{margin:0;display:grid;place-items:center;min-height:100vh;font:14px/1.5 system-ui,sans-serif;color:#555;background:#fff}p{margin:24px;text-align:center}</style>
</head><body><p>${notice}</p>
<script nonce="${nonce}">if(window.parent!==window)window.parent.postMessage(${JSON.stringify(status)},${JSON.stringify(input.hostOrigin)});</script>
</body></html>`;
  return new Response(input.method === "HEAD" ? null : body, {
    status: input.block.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        PAGE_SANDBOX,
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "webrtc 'block'",
        `frame-ancestors ${input.hostOrigin}`,
      ].join("; "),
      ...COMMON,
    },
  });
}

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
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), xr-spatial-tracking=(), publickey-credentials-get=(), screen-wake-lock=()",
} as const;

export function sandboxRedirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...COMMON } });
}
