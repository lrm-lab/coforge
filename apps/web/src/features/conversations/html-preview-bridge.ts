/**
 * The bridge between a previewed HTML file and the page showing it, as in Raft 1.0.53.
 *
 * The frame is `sandbox="allow-scripts"` without `allow-same-origin`: an opaque origin that holds
 * none of our cookies and cannot touch this page. The only script it may run is the bridge below,
 * admitted by a per-render CSP nonce; the file's own scripts, event-handler attributes and
 * `javascript:` URLs are all refused by that policy.
 *
 * The file's markup never travels as a string the frame re-parses. Parsing it in this page and
 * serializing it back would be read twice under different rules (an inert `DOMParser` parses with
 * scripting disabled, the frame with it enabled, and `<noscript>` reads differently in each), which
 * lets markup that looks harmless here become a live `<meta http-equiv="refresh">` there. Instead
 * the frame starts with only the policy and the bridge, the file is posted to the bridge, and the
 * bridge parses it once, inertly, strips what could navigate or load, and adopts the nodes.
 */

/** Tags every message either way, so neither side mistakes another script's messages for ours. */
export const BRIDGE = "coforge-html";

/** The frame's scroll position and sizes, in CSS pixels. */
export type BridgeState = {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
};

/** A box in document coordinates (scroll included). */
export type DocumentBox = { x: number; y: number; w: number; h: number };

/** An `http`/`https` link the reader can see, as a box in the frame's viewport. */
export type FrameLink = DocumentBox & { href: string };

/** How many visible link boxes the bridge reports at most. */
const LINKS_MAX = 300;

/** What the bridge sends this page. */
export type FrameMessage =
  | { type: "ready" }
  | ({ type: "state"; links: FrameLink[] } & BridgeState)
  | { type: "quote"; id: number; quote: string }
  | { type: "located"; id: number; box: DocumentBox | null };

/** What this page sends the bridge. */
export type ParentMessage =
  | { type: "render"; html: string }
  | { type: "scrollTo"; x: number; y: number }
  | { type: "scrollBy"; x: number; y: number }
  | { type: "quoteAt"; id: number; box: DocumentBox }
  | { type: "locate"; id: number; quote: string; hintY: number };

/** One render's credentials: a fresh nonce for its CSP, and a count that retires older frames. */
export type BridgeSession = { nonce: string; epoch: number };

let epochs = 0;

export function newBridgeSession(): BridgeSession {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return { nonce, epoch: ++epochs };
}

/**
 * The frame's whole document before the file arrives: standards mode, the policy, the bridge.
 * `base-uri` and `form-action` are not covered by `default-src`, so they are closed by name.
 */
export function bridgeSrcDoc({ nonce, epoch }: BridgeSession): string {
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const script = `(${bridgeMain.toString()})(${JSON.stringify(BRIDGE)}, ${JSON.stringify(nonce)}, ${epoch});`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><script nonce="${nonce}">${script.replace(/<\//g, "<\\/")}</script></head><body></body></html>`;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBox = (value: unknown): value is DocumentBox => {
  const box = value as DocumentBox | null;
  return !!box && finite(box.x) && finite(box.y) && finite(box.w) && finite(box.h);
};

/**
 * A message from the frame this page rendered, in its current session, or `null` for anything
 * else: another window, an earlier render, or a shape the bridge does not send. The frame's
 * origin is opaque (`"null"`), so the sending window, not the origin, is what identifies it.
 */
export function acceptBridgeMessage(
  event: { source: unknown; data: unknown },
  frame: Window | null | undefined,
  session: BridgeSession,
): FrameMessage | null {
  if (!frame || event.source !== frame) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  if (data.bridge !== BRIDGE || data.nonce !== session.nonce || data.epoch !== session.epoch)
    return null;
  switch (data.type) {
    case "ready":
      return { type: "ready" };
    case "state": {
      const { scrollX, scrollY, viewportWidth, viewportHeight, documentWidth, documentHeight } =
        data;
      if (
        ![scrollX, scrollY, viewportWidth, viewportHeight, documentWidth, documentHeight].every(
          finite,
        )
      )
        return null;
      const links = Array.isArray(data.links) ? data.links.slice(0, LINKS_MAX) : [];
      if (!links.every((link) => isBox(link) && typeof (link as FrameLink).href === "string"))
        return null;
      return {
        links: links.map(({ href, x, y, w, h }: FrameLink) => ({ href, x, y, w, h })),
        type: "state",
        scrollX,
        scrollY,
        viewportWidth,
        viewportHeight,
        documentWidth,
        documentHeight,
      } as FrameMessage;
    }
    case "quote":
      return finite(data.id) && typeof data.quote === "string"
        ? { type: "quote", id: data.id, quote: data.quote }
        : null;
    case "located":
      return finite(data.id) && (data.box === null || isBox(data.box))
        ? { type: "located", id: data.id, box: data.box }
        : null;
    default:
      return null;
  }
}

/** The page's message to the bridge, tagged with the session the bridge checks. */
export function bridgeMessage(session: BridgeSession, message: ParentMessage) {
  return { bridge: BRIDGE, nonce: session.nonce, epoch: session.epoch, ...message };
}

/**
 * The bridge itself, run inside the frame as source text (`toString`), so it must stay
 * self-contained: no imports, no outer names, nothing a bundler would pull in.
 */
function bridgeMain(bridge: string, nonce: string, epoch: number) {
  // How much text a region or a search reads at most; the stored quote is shorter still.
  const TEXT_MAX = 2000;
  const SEARCH_MAX = 200;
  const LINKS_MAX = 300;
  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage(Object.assign({ bridge, nonce, epoch }, message), "*");

  // Where the visible `http`/`https` links are, for the page to lay its own hotspots over them:
  // a link never navigates this frame, the page opens it in a new tab instead.
  const visibleLinks = () => {
    const links: { href: string; x: number; y: number; w: number; h: number }[] = [];
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      let url: URL;
      try {
        url = new URL(anchor.getAttribute("href") || "");
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      for (const rect of Array.from(anchor.getClientRects())) {
        if (links.length >= LINKS_MAX) return links;
        if (rect.width === 0 || rect.bottom < 0 || rect.right < 0) continue;
        if (rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
        links.push({ href: url.href, x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    }
    return links;
  };

  let frame = 0;
  const sendState = () => {
    frame = 0;
    const root = document.documentElement;
    const body = document.body;
    post({
      type: "state",
      links: visibleLinks(),
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      viewportWidth: root.clientWidth || window.innerWidth,
      viewportHeight: root.clientHeight || window.innerHeight,
      documentWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0),
      documentHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0),
    });
  };
  const scheduleState = () => {
    if (!frame) frame = requestAnimationFrame(sendState);
  };

  // The file's text nodes a reader sees, in document order.
  const textNodes = () => {
    const nodes: Text[] = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest("style, template, textarea, title")) nodes.push(node as Text);
    }
    return nodes;
  };

  const textIn = (box: { x: number; y: number; w: number; h: number }) => {
    const left = box.x - window.scrollX;
    const top = box.y - window.scrollY;
    if (box.w === 0 && box.h === 0) {
      const element = document.elementFromPoint(left, top);
      if (!element || element === document.body || element === document.documentElement) return "";
      return ((element as HTMLElement).innerText || element.textContent || "").slice(0, TEXT_MAX);
    }
    const right = left + box.w;
    const bottom = top + box.h;
    const range = document.createRange();
    const parts: string[] = [];
    let length = 0;
    for (const node of textNodes()) {
      if (length >= TEXT_MAX) break;
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      const hit = Array.from(range.getClientRects()).some(
        (rect) => rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom,
      );
      if (hit) {
        parts.push(node.data);
        length += node.data.length;
      }
    }
    return parts.join(" ").slice(0, TEXT_MAX);
  };

  // The quote's place, whitespace aside, nearest `hintY` where it occurs more than once.
  const locate = (quote: string, hintY: number) => {
    const wanted = quote.replace(/\s+/g, "");
    if (!wanted) return null;
    const nodes = textNodes();
    const starts: number[] = [];
    let joined = "";
    const kept: Text[] = [];
    for (const node of nodes) {
      const compact = node.data.replace(/\s+/g, "");
      if (!compact) continue;
      kept.push(node);
      starts.push(joined.length);
      joined += compact;
    }
    const range = document.createRange();
    let best: { x: number; y: number; w: number; h: number } | null = null;
    let bestDistance = Infinity;
    let found = joined.indexOf(wanted);
    for (let count = 0; found !== -1 && count < SEARCH_MAX; count++) {
      const end = found + wanted.length;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (let i = 0; i < kept.length && starts[i]! < end; i++) {
        const next = i + 1 < kept.length ? starts[i + 1]! : joined.length;
        if (next <= found) continue;
        range.selectNodeContents(kept[i]!);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (left !== Infinity) {
        const y = top + window.scrollY;
        const distance = Math.abs(y + (bottom - top) / 2 - hintY);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = {
            x: Math.round(left + window.scrollX),
            y: Math.round(y),
            w: Math.round(right - left),
            h: Math.round(bottom - top),
          };
        }
      }
      found = joined.indexOf(wanted, found + 1);
    }
    return best;
  };

  const copyAttributes = (from: Element | null, to: Element) => {
    if (!from) return;
    for (const attribute of Array.from(from.attributes))
      if (!attribute.name.toLowerCase().startsWith("on"))
        to.setAttribute(attribute.name, attribute.value);
  };

  let rendered = false;
  const render = (html: string) => {
    // Inert: a parsed document runs nothing and loads nothing until its nodes join this one.
    const parsed = new DOMParser().parseFromString(html, "text/html");
    // Parsed with scripting disabled, `<noscript>` holds real elements: shown, as before, since
    // the file's scripts never run.
    for (const noscript of Array.from(parsed.querySelectorAll("noscript")))
      noscript.replaceWith(...Array.from(noscript.childNodes));
    // What could navigate this frame (a refresh), change where its links go, or open a nested
    // document of its own (which would inherit `allow-scripts` but answer to no bridge).
    for (const element of Array.from(
      parsed.querySelectorAll(
        "script, meta[http-equiv], base, link, iframe, frame, frameset, object, embed, portal",
      ),
    ))
      element.remove();
    copyAttributes(parsed.documentElement, document.documentElement);
    copyAttributes(parsed.body, document.body);
    document.head.append(...Array.from(parsed.head.childNodes));
    if (parsed.body) document.body.append(...Array.from(parsed.body.childNodes));
    // State is the file's from the first message on, so its arrival means "rendered".
    window.addEventListener("scroll", scheduleState, { passive: true });
    window.addEventListener("resize", scheduleState);
    new ResizeObserver(scheduleState).observe(document.documentElement);
    scheduleState();
  };

  // A link never takes this frame elsewhere: the page off this document would answer to no one.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      if (target && target.closest && target.closest("a, area")) event.preventDefault();
    },
    true,
  );
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.bridge !== bridge || message.nonce !== nonce) return;
    if (message.type === "render") {
      // Only the first: the file is rendered once, never replaced by a later message.
      if (rendered || typeof message.html !== "string") return;
      rendered = true;
      render(message.html);
    } else if (message.type === "scrollTo") window.scrollTo(message.x, message.y);
    else if (message.type === "scrollBy") window.scrollBy(message.x, message.y);
    else if (message.type === "quoteAt")
      post({ type: "quote", id: message.id, quote: textIn(message.box) });
    else if (message.type === "locate")
      post({ type: "located", id: message.id, box: locate(message.quote, message.hintY) });
  });
  post({ type: "ready" });
}
