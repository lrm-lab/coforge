import {
  TEXT_ANCHOR_LIMITS,
  createTextAnchors,
} from "#src/features/artifacts/artifact-text-anchor";

export const ANNOTATE_TEXT_SOURCE = `
var textAnchors = (${createTextAnchors.toString()})(${JSON.stringify(TEXT_ANCHOR_LIMITS)});
var joinPieces = textAnchors.joinPieces;
var quoteAnchor = textAnchors.quoteAnchor;
var findQuote = textAnchors.findQuote;
var firstIndexWhere = textAnchors.firstIndexWhere;
var clip = textAnchors.clip;
var collapsed = textAnchors.collapsed;
`;

export const ANNOTATE_LOCATE_SOURCE = String.raw`
function boxOf(rect) {
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
}
function placeBox(box, rect) {
  box.style.left = (rect.left + window.scrollX) + "px";
  box.style.top = (rect.top + window.scrollY) + "px";
  box.style.width = rect.width + "px";
  box.style.height = rect.height + "px";
}
function paintBox(parent, rect, style) {
  var box = document.createElement("div");
  box.style.cssText = "position:absolute;box-sizing:border-box;pointer-events:none;" + style;
  placeBox(box, rect);
  parent.appendChild(box);
  return box;
}
var STABLE_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "data-id", "data-name", "data-section", "data-component", "data-key"];
function stableValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[:\u00ab\u00bb]|(^|[-_])\d+([-_]|$)|\d{5,}|^[a-f0-9]{8,}$/i.test(value);
}
function isUnique(selector, element) {
  try {
    var all = document.querySelectorAll(selector);
    return all.length === 1 && all[0] === element;
  } catch (error) {
    return false;
  }
}
function anchorSelector(element) {
  var tag = element.tagName.toLowerCase();
  if (stableValue(element.id)) {
    var byId = "#" + CSS.escape(element.id);
    if (isUnique(byId, element)) return byId;
  }
  for (var i = 0; i < STABLE_ATTRIBUTES.length; i++) {
    var value = element.getAttribute(STABLE_ATTRIBUTES[i]);
    if (!stableValue(value)) continue;
    var bySelector = tag + "[" + STABLE_ATTRIBUTES[i] + "=" + JSON.stringify(value) + "]";
    if (isUnique(bySelector, element)) return bySelector;
  }
  return null;
}
function positionStep(node) {
  var tag = node.tagName.toLowerCase();
  var parent = node.parentElement;
  if (!parent) return tag;
  var same = 0;
  var index = 0;
  for (var i = 0; i < parent.children.length; i++) {
    var sibling = parent.children[i];
    if (sibling.tagName === node.tagName) {
      same += 1;
      if (sibling === node) index = same;
    }
  }
  return same > 1 ? tag + ":nth-of-type(" + index + ")" : tag;
}
function selectorOf(element) {
  var direct = anchorSelector(element);
  if (direct) return direct;
  var steps = [];
  var node = element;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    var head = node === element ? null : anchorSelector(node);
    if (head) {
      steps.unshift(head);
      break;
    }
    if (node === document.body) {
      steps.unshift("body");
      break;
    }
    steps.unshift(positionStep(node));
    node = node.parentElement;
  }
  var selector = steps.join(" > ");
  return selector.length <= 1000 && isUnique(selector, element) ? selector : null;
}
function labelOf(element) {
  var text = String(element.innerText || element.textContent || "").slice(0, 1000).replace(/\s+/g, " ").trim();
  if (!text) {
    var names = ["aria-label", "alt", "title", "placeholder", "value"];
    for (var i = 0; i < names.length && !text; i++) text = String(element.getAttribute(names[i]) || "").replace(/\s+/g, " ").trim();
  }
  return clip(text || "<" + element.tagName.toLowerCase() + ">", 120);
}
function elementData(element) {
  var selector = selectorOf(element);
  if (!selector) return null;
  var data = { selector: selector };
  var label = labelOf(element);
  if (label) data.quote = label;
  return data;
}
function blockOf(element, cache) {
  var cached = cache.get(element);
  if (cached) return cached;
  var node = element;
  while (node && node !== document.body) {
    var display = getComputedStyle(node).display;
    if (display.indexOf("inline") !== 0 && display !== "contents") break;
    node = node.parentElement;
  }
  var block = node || document.body;
  cache.set(element, block);
  return block;
}
function textIndex() {
  if (textCache && !indexDirty) return textCache;
  var pieces = [];
  var nodes = [];
  var maps = [];
  var blocks = new Map();
  var visible = new Map();
  var spacing = new Map();
  var body = document.body;
  if (body) {
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || node.nodeValue.length === 0) continue;
      var shown = visible.get(parent);
      if (shown === undefined) {
        shown = typeof parent.checkVisibility === "function" ? parent.checkVisibility() : parent.getClientRects().length > 0;
        visible.set(parent, shown);
      }
      if (!shown) continue;
      var keep = spacing.get(parent);
      if (keep === undefined) {
        keep = /^pre/.test(getComputedStyle(parent).whiteSpace);
        spacing.set(parent, keep);
      }
      var piece = keep ? { text: node.nodeValue, map: null } : collapsed(node.nodeValue);
      pieces.push([piece.text, blockOf(parent, blocks)]);
      nodes.push(node);
      maps.push(piece.map);
    }
  }
  var joined = joinPieces(pieces);
  textCache = { text: joined.text, starts: joined.starts, nodes: nodes, maps: maps, lengths: pieces.map(function (piece) { return piece[0].length; }) };
  indexDirty = false;
  return textCache;
}
function toText(index, at, raw) {
  var map = index.maps[at];
  return map ? map[raw] : raw;
}
function toRaw(index, at, offset) {
  var map = index.maps[at];
  return map ? firstIndexWhere(map, function (value) { return value >= offset; }) : offset;
}
function selectionOffsets(index, range) {
  var start = -1;
  var end = -1;
  for (var i = 0; i < index.nodes.length; i++) {
    var node = index.nodes[i];
    var contents = document.createRange();
    contents.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.START_TO_END, contents) <= 0) break;
    if (range.compareBoundaryPoints(Range.END_TO_START, contents) >= 0) continue;
    var from = node === range.startContainer ? range.startOffset : 0;
    var to = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    var first = index.starts[i] + toText(index, i, from);
    var last = index.starts[i] + toText(index, i, to);
    if (last <= first) continue;
    if (start < 0) start = first;
    end = last;
  }
  return start < 0 ? null : { start: start, end: end };
}
function rangeOfSpan(index, span) {
  var from = firstIndexWhere(index.starts, function (value) { return value > span.start; }) - 1;
  if (from < 0) return null;
  var offset = span.start - index.starts[from];
  if (offset >= index.lengths[from]) {
    from += 1;
    offset = 0;
  }
  var to = firstIndexWhere(index.starts, function (value) { return value >= span.end; }) - 1;
  if (from >= index.nodes.length || to < from) return null;
  var tail = Math.min(span.end - index.starts[to], index.lengths[to]);
  var range = document.createRange();
  try {
    range.setStart(index.nodes[from], toRaw(index, from, offset));
    range.setEnd(index.nodes[to], toRaw(index, to, tail));
  } catch (error) {
    return null;
  }
  return range;
}
function locateAnchor(anchor) {
  if (!anchor || !anchor.data) return null;
  if (anchor.type === "element") {
    var found = null;
    try { found = document.querySelector(anchor.data.selector); } catch (error) { found = null; }
    if (!found || found.getClientRects().length === 0) return null;
    return {
      kind: "element",
      node: found,
      rects: function () { return [found.getBoundingClientRect()]; },
      boxStyle: function (strong) { return "border:2px solid " + ACCENT + ";background:" + (strong ? "transparent" : "rgba(224,109,59,.10)") + ";border-radius:4px"; },
      badgeAt: function (rect) { return { left: rect.right - 8, top: rect.top - 20 }; }
    };
  }
  if (anchor.type === "text") {
    var index = textIndex();
    var span = findQuote(index.text, anchor.data);
    var range = span && rangeOfSpan(index, span);
    if (!range || range.getClientRects().length === 0) return null;
    return {
      kind: "text",
      node: range.startContainer,
      rects: function () { return Array.prototype.slice.call(range.getClientRects()); },
      boxStyle: function (strong) { return "background:rgba(255,214,10," + (strong ? ".6" : ".4") + ");border-radius:2px"; },
      badgeAt: function (rect) { return { left: rect.left - 4, top: rect.top - 22 }; }
    };
  }
  return null;
}
`;
