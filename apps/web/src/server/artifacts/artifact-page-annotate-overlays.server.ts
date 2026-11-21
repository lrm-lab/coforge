export const ANNOTATE_OVERLAY_SOURCE = String.raw`
var ACCENT = "var(--coforge-brand, #e06d3b)";
var ACCENT_FG = "var(--coforge-brand-fg, #ffffff)";
var ACCENT_FILL = "color-mix(in srgb, var(--coforge-brand, #e06d3b) 10%, transparent)";
var DRAFT_ACCENT = "var(--coforge-warning, var(--coforge-brand, #e06d3b))";
var DRAFT_FILL = "color-mix(in srgb, var(--coforge-warning, var(--coforge-brand, #e06d3b)) 7%, transparent)";
var PIN_BG = "var(--coforge-surface, #ffffff)";
var PIN_FG = "var(--coforge-fg, #18181b)";
var PIN_BORDER = "var(--coforge-border, #d4d4d8)";
var HOVER_PREVIEW_MAX = 48;
var BADGE_SIZE = 24;
var BADGE_SHADOW = "0 2px 6px rgba(0,0,0,.22)";
var BADGE_FLASH_SHADOW = BADGE_SHADOW + ",0 0 0 4px color-mix(in srgb, var(--coforge-brand, #e06d3b) 40%, transparent)";
var PIN_ICON_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5A2.5 2.5 0 0 1 13.5 13H9l-3.5 3v-3H6.5A2.5 2.5 0 0 1 4 10.5v-5Z"/></svg>';
function drawDraftPins() {
  var parent = layer("draft-pins");
  parent.textContent = "";
  var viewportWidth = document.documentElement.clientWidth;
  placed.forEach(function (entry) {
    if (!entry.mark.draft) return;
    var rects = entry.target.rects();
    if (!rects.length) return;
    if (entry.target.kind === "element") {
      paintBox(parent, rects[0], "border-radius:6px;border:1.5px dashed " + DRAFT_ACCENT + ";background:" + DRAFT_FILL);
      if (!annotate.showMarks) {
        var pin = document.createElement("div");
        var left = Math.max(4, Math.min(rects[0].right - 12, viewportWidth - 28)) + window.scrollX;
        var top = Math.max(4, rects[0].top - 12 + window.scrollY);
        pin.setAttribute("data-draft-pin", entry.mark.id);
        pin.innerHTML = PIN_ICON_SVG;
        pin.style.cssText = "position:absolute;pointer-events:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:8px;background:" + PIN_BG + ";color:" + PIN_FG + ";border:1px solid " + PIN_BORDER + ";box-shadow:" + BADGE_SHADOW + ";left:" + left + "px;top:" + top + "px";
        parent.appendChild(pin);
      }
    } else {
      paintTarget(parent, entry.target, false);
    }
  });
}
function boundedTextOf(root, limit) {
  var out = "";
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var parent = node.parentElement;
      if (!parent || parent === overlay) return NodeFilter.FILTER_REJECT;
      var tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || parent.hidden) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var current = walker.nextNode();
  while (current && out.length < limit) {
    var chunk = String(current.nodeValue || "").replace(/\s+/g, " ").trim();
    if (chunk) out = out ? out + " " + chunk : chunk;
    current = walker.nextNode();
  }
  return out.slice(0, limit).trim();
}
function hoverPreview(element) {
  var text = boundedTextOf(element, 120);
  if (!text) {
    var names = ["aria-label", "alt", "title", "placeholder"];
    for (var i = 0; i < names.length && !text; i++) text = String(element.getAttribute(names[i]) || "").replace(/\s+/g, " ").trim();
  }
  return text ? clip(text, HOVER_PREVIEW_MAX) : "";
}
function ensureHoverBadge() {
  if (hoverBadge) return hoverBadge;
  hoverBadge = document.createElement("div");
  hoverBadge.setAttribute("data-pick-hover-label", "");
  hoverBadge.style.cssText = "position:absolute;pointer-events:none;display:inline-flex;align-items:center;gap:6px;max-width:280px;padding:2px 7px;border-radius:4px;background:" + ACCENT + ";color:" + ACCENT_FG + ";font:500 11px/1.35 var(--coforge-font-sans,system-ui,sans-serif);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px rgba(0,0,0,.22)";
  layer("pick-hover").appendChild(hoverBadge);
  return hoverBadge;
}
function placeHoverBadge(element, rect, changed, viewportWidth, scrollX, scrollY) {
  var badge = ensureHoverBadge();
  if (changed) {
    var tag = stepName(element);
    var preview = hoverPreview(element);
    var label = preview ? tag + " " + preview : tag;
    if (label !== hoverBadgeText) {
      hoverBadgeText = label;
      badge.textContent = label;
      hoverBadgeHeight = badge.offsetHeight || 20;
      hoverBadgeWidth = badge.offsetWidth || 120;
    }
  }
  var badgeHeight = hoverBadgeHeight || 20;
  var badgeWidth = hoverBadgeWidth || 120;
  var anchorTop = Math.max(0, rect.top);
  var top = anchorTop >= badgeHeight + 6 ? anchorTop - badgeHeight - 4 : anchorTop + 4;
  var left = Math.max(4, Math.min(rect.left, viewportWidth - badgeWidth - 4));
  badge.style.left = (left + scrollX) + "px";
  badge.style.top = Math.max(4, top + scrollY) + "px";
}
`;
