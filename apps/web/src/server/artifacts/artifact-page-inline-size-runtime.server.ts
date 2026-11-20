export const INLINE_SIZE_RUNTIME_SOURCE = `var viewportStage = false;
var inlineStageChecked = false;
var VIEWPORT_UNIT = /(?:^|[\\s(])(?:100%(?=$|[\\s);,])|\\d+(?:\\.\\d+)?[dls]?vh\\b)/i;
var SCREEN_CLASS = /(?:^|\\s)h-(?:screen|dvh|svh|full)(?:\\s|$)/;
var matchesRoot = function (selectorText) {
  var parts = String(selectorText || "").split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var s = parts[i].trim().toLowerCase();
    if (s === "html" || s === "body" || s === ":root") return true;
  }
  return false;
};
var rulesHaveViewportHeight = function (rules, depth) {
  if (!rules || depth > 2) return false;
  for (var j = 0; j < rules.length; j += 1) {
    var rule = rules[j];
    if (!rule) continue;
    if (rule.selectorText && rule.style && matchesRoot(rule.selectorText)) {
      if (VIEWPORT_UNIT.test(rule.style.height || "") || VIEWPORT_UNIT.test(rule.style.minHeight || "")) return true;
    } else if (rule.cssRules && rulesHaveViewportHeight(rule.cssRules, depth + 1)) {
      return true;
    }
  }
  return false;
};
var hasViewportHeightRule = function () {
  var sheets = document.styleSheets;
  if (!sheets) return false;
  for (var i = 0; i < sheets.length; i += 1) {
    var rules;
    try {
      rules = sheets[i].cssRules;
    } catch (error) {
      continue;
    }
    if (rulesHaveViewportHeight(rules, 0)) return true;
  }
  return false;
};
var hasLargeStageMedia = function (rootEl, vw, vh) {
  if (!rootEl || vw <= 0 || vh <= 0) return false;
  var media = rootEl.querySelectorAll("canvas, svg, video");
  for (var i = 0; i < media.length && i < 24; i += 1) {
    var r = media[i].getBoundingClientRect();
    if (r.width >= vw * 0.5 && r.height >= vh * 0.5) return true;
  }
  return false;
};
var hasFullBleedChild = function (vw, vh, requireFixed) {
  if (!document.body || vw <= 0 || vh <= 0) return false;
  var nodes = document.body.children;
  for (var i = 0; i < nodes.length && i < 32; i += 1) {
    var el = nodes[i];
    var cs = getComputedStyle(el);
    var fixed = cs.position === "fixed";
    if (requireFixed && !fixed) continue;
    if (!fixed && cs.position !== "absolute") continue;
    var r = el.getBoundingClientRect();
    if (r.width >= vw * 0.7 && r.height >= vh * 0.7) return true;
  }
  return false;
};
var hasViewportStageWrapper = function (vw, vh) {
  if (!document.body || vw <= 0 || vh <= 0) return false;
  var nodes = document.body.children;
  for (var i = 0; i < nodes.length && i < 16; i += 1) {
    var el = nodes[i];
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (r.width < vw * 0.85 || r.height < vh * 0.85) continue;
    var hidden = cs.overflowY === "hidden" || cs.overflowY === "clip";
    var cls = typeof el.className === "string" ? el.className : "";
    if (hidden && (VIEWPORT_UNIT.test(el.style.height || "") || SCREEN_CLASS.test(cls))) return true;
    if (hidden && hasLargeStageMedia(el, vw, vh)) return true;
  }
  return false;
};
var detectViewportStage = function (naturalH, vw, vh) {
  if (viewportStage) return true;
  if (inlineStageChecked || vh <= 0 || vh > 260 || !document.body) return false;
  inlineStageChecked = true;
  if (naturalH > 4 && Math.abs(naturalH - vh) > 2) return false;
  if (naturalH <= 4) {
    if (hasFullBleedChild(vw, vh, true)) {
      viewportStage = true;
      return true;
    }
    return false;
  }
  if (hasViewportStageWrapper(vw, vh)) {
    viewportStage = true;
    return true;
  }
  var root = document.documentElement;
  var body = document.body;
  var rootCs = getComputedStyle(root);
  var bodyCs = getComputedStyle(body);
  var lockedOverflow =
    rootCs.overflowY === "hidden" ||
    rootCs.overflowY === "clip" ||
    bodyCs.overflowY === "hidden" ||
    bodyCs.overflowY === "clip" ||
    bodyCs.position === "fixed";
  var rootViewportHeight =
    VIEWPORT_UNIT.test(root.style.height || "") ||
    VIEWPORT_UNIT.test(root.style.minHeight || "") ||
    VIEWPORT_UNIT.test(body.style.height || "") ||
    VIEWPORT_UNIT.test(body.style.minHeight || "") ||
    hasViewportHeightRule();
  if (hasFullBleedChild(vw, vh, false) && (lockedOverflow || rootViewportHeight)) {
    viewportStage = true;
    return true;
  }
  if (rootViewportHeight && (lockedOverflow || hasLargeStageMedia(body, vw, vh))) {
    viewportStage = true;
    return true;
  }
  return false;
};
var measureSize = function () {
  var root = document.documentElement;
  var body = document.body;
  if (displayMode === "inline" && body) {
    var rect = body.getBoundingClientRect();
    var vw = window.innerWidth || root.clientWidth || 896;
    var vh = window.innerHeight || 0;
    var naturalH = Math.ceil(Math.max(body.scrollHeight, body.offsetHeight, rect ? rect.height : 0));
    var width = Math.ceil(Math.max(root.scrollWidth, body.scrollWidth));
    if (detectViewportStage(naturalH, vw, vh)) {
      return { width: width, height: Math.max(320, Math.min(500, Math.round(vw * 0.68))) };
    }
    return { width: width, height: naturalH };
  }
  return {
    width: Math.ceil(root.scrollWidth),
    height: Math.ceil(root.scrollHeight),
  };
};
`;
