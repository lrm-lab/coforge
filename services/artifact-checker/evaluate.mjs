export const INLINE_HOST_ORIGIN = "https://host.coforge.check";
export const INLINE_HOST_PATH = "/__coforge_check_inline_host__";
export const INLINE_MAX_HEIGHT_PX = 800;
export const INLINE_MIN_HEIGHT_PX = 96;

export const INLINE_LIGHT_TOKENS = Object.freeze({
  "--coforge-bg": "#ffffff",
  "--coforge-surface": "#f9fafb",
  "--coforge-surface-subtle": "#f2f4f7",
  "--coforge-fg": "#101828",
  "--coforge-fg-secondary": "#344054",
  "--coforge-fg-muted": "#667085",
  "--coforge-border": "#d0d5dd",
  "--coforge-border-subtle": "#eaecf0",
  "--coforge-brand": "#1570ef",
  "--coforge-brand-fg": "#ffffff",
  "--coforge-success": "#079455",
  "--coforge-warning": "#dc6803",
  "--coforge-error": "#d92d20",
  "--coforge-chart-1": "#2e90fa",
  "--coforge-chart-2": "#17b26a",
  "--coforge-chart-3": "#f79009",
  "--coforge-chart-4": "#ef6820",
  "--coforge-chart-5": "#ee46bc",
  "--coforge-chart-6": "#7a5af8",
});

function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function clampInlineHeight(height) {
  if (!Number.isFinite(height) || height <= 0) return 200;
  return Math.min(INLINE_MAX_HEIGHT_PX, Math.max(INLINE_MIN_HEIGHT_PX, Math.ceil(height)));
}

export function buildInlineHostHtml({
  entryUrl,
  artifactOrigin,
  width = 672,
  maxHeight = INLINE_MAX_HEIGHT_PX,
}) {
  const targetOrigin = artifactOrigin || new URL(entryUrl).origin;
  const safeSrc = safeJsonForScript(entryUrl);
  const safeOrigin = safeJsonForScript(targetOrigin);
  const safeTokens = safeJsonForScript(INLINE_LIGHT_TOKENS);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  #artifact-frame { display: block; width: ${Math.round(width)}px; height: ${Math.round(maxHeight)}px; border: 0; background: transparent; }
</style>
</head>
<body>
<iframe id="artifact-frame" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
(function () {
  var frame = document.getElementById("artifact-frame");
  var targetOrigin = ${safeOrigin};
  var tokens = ${safeTokens};
  window.__coforgeInlineSize = null;
  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow || event.origin !== targetOrigin) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.method === "ui/initialize" && msg.id != null) {
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-01-26",
          hostContext: { theme: "light", displayMode: "inline", tokens: tokens }
        }
      }, targetOrigin);
      return;
    }
    if (msg.method === "ui/notifications/size-changed" && msg.params) {
      var h = Number(msg.params.height);
      if (Number.isFinite(h) && h > 0) window.__coforgeInlineSize = h;
    }
  });
  frame.src = ${safeSrc};
})();
</script>
</body>
</html>`;
}

export function collectDomDiagnosticsInPage(input) {
  const shot = input.shot;
  const maxInlineHeight = input.maxInlineHeight || 800;
  const docEl = document.documentElement;
  const body = document.body;
  const innerWidth = window.innerWidth || 0;
  const innerHeight = window.innerHeight || 0;
  const scrollWidth = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
  const scrollHeight = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0);

  const visibleText = body && typeof body.innerText === "string" ? body.innerText.trim() : "";
  let hasVisual = visibleText.length > 0;
  if (!hasVisual && body) {
    const visuals = body.querySelectorAll("svg, canvas, img, video, input, button, select, textarea");
    for (let i = 0; i < visuals.length; i += 1) {
      const rect = visuals[i].getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) {
        hasVisual = true;
        break;
      }
    }
  }

  let maxDescendantBottom = scrollHeight;
  if (body) {
    const nodes = body.querySelectorAll("*");
    const limit = Math.min(nodes.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > maxDescendantBottom) {
        maxDescendantBottom = rect.bottom;
      }
    }
  }

  let phoneOverflow = null;
  if (shot === "phone" && scrollWidth > innerWidth + 1) {
    phoneOverflow = {
      contentWidth: Math.round(scrollWidth),
      viewportWidth: Math.round(innerWidth),
    };
  }

  let inlineOverflow = null;
  if (shot === "inline") {
    const bodyRectHeight = body ? body.getBoundingClientRect().height : 0;
    const measuredHeight = Math.max(
      body ? body.scrollHeight : 0,
      bodyRectHeight,
      maxDescendantBottom,
    );
    const rounded = Math.round(measuredHeight);
    inlineOverflow = {
      contentHeight: rounded,
      maxHeight: maxInlineHeight,
      clipped: rounded > maxInlineHeight,
    };
  }

  const brokenImages = [];
  if (body) {
    const imgs = body.querySelectorAll("img");
    for (let i = 0; i < imgs.length && brokenImages.length < 10; i += 1) {
      const img = imgs[i];
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (src && img.complete && img.naturalWidth === 0) {
        brokenImages.push(src.slice(0, 300));
      }
    }
  }

  let scrollLock = null;
  if (shot === "desktop" || shot === "phone") {
    const heldBy = [];
    const describeElement = (el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${tag}${id}${cls}`.slice(0, 120);
    };
    const candidates = [docEl, body];
    if (body) {
      for (let i = 0; i < Math.min(body.children.length, 8); i += 1) {
        candidates.push(body.children[i]);
      }
    }
    let lockedOverflowHeight = 0;
    for (const el of candidates) {
      if (!el || typeof getComputedStyle !== "function") continue;
      const cs = getComputedStyle(el);
      const oy = cs.overflowY || cs.overflow;
      if (oy === "hidden" || oy === "clip") {
        const hidden = Math.round(el.scrollHeight - el.clientHeight);
        if (hidden > 24 && el.clientHeight >= innerHeight * 0.7) {
          lockedOverflowHeight = Math.max(lockedOverflowHeight, el.scrollHeight);
          heldBy.push({
            element: describeElement(el),
            style: `overflow-y:${oy}; height:${cs.height}`,
          });
        }
      }
    }
    let hasInnerScroller = false;
    if (body && typeof getComputedStyle === "function") {
      const containers = body.querySelectorAll("main, [role='main'], section, article, div");
      for (let i = 0; i < Math.min(containers.length, 60); i += 1) {
        const el = containers[i];
        const cs = getComputedStyle(el);
        const oy = cs.overflowY || cs.overflow;
        if (
          (oy === "auto" || oy === "scroll") &&
          el.clientHeight >= innerHeight * 0.45 &&
          el.scrollHeight > el.clientHeight + 24
        ) {
          hasInnerScroller = true;
          break;
        }
      }
    }
    const docOverflowHeight = Math.max(
      lockedOverflowHeight,
      docEl.scrollHeight || 0,
      body ? body.scrollHeight || 0 : 0,
    );
    const rootStyle = typeof getComputedStyle === "function" ? getComputedStyle(docEl) : null;
    const bodyStyle =
      body && typeof getComputedStyle === "function" ? getComputedStyle(body) : null;
    const rootLocked =
      heldBy.length > 0 ||
      rootStyle?.overflowY === "hidden" ||
      rootStyle?.overflowY === "clip" ||
      bodyStyle?.overflowY === "hidden" ||
      bodyStyle?.overflowY === "clip" ||
      bodyStyle?.position === "fixed";
    if (!hasInnerScroller && rootLocked && docOverflowHeight > innerHeight + 24) {
      const prevX = window.scrollX || 0;
      const prevY = window.scrollY || 0;
      window.scrollTo({ top: 64, left: prevX, behavior: "instant" });
      const moved = Math.abs((window.scrollY || 0) - prevY) > 1;
      window.scrollTo({ top: prevY, left: prevX, behavior: "instant" });
      if (!moved) {
        scrollLock = {
          shot,
          viewportWidth: Math.round(innerWidth),
          viewportHeight: Math.round(innerHeight),
          contentHeight: Math.round(docOverflowHeight),
          hiddenHeight: Math.round(docOverflowHeight - innerHeight),
          heldBy: heldBy.slice(0, 5),
        };
      }
    }
  }

  return {
    blank: !hasVisual,
    phoneOverflow,
    inlineOverflow,
    scrollLock,
    brokenImages,
  };
}
