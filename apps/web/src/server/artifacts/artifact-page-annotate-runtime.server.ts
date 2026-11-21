import {
  TRAIL_ANCESTORS_MAX,
  TRAIL_NAME_MAX,
} from "#src/features/artifacts/artifact-page-annotations";
import { ANNOTATE_OVERLAY_SOURCE } from "./artifact-page-annotate-overlays.server";

export const ANNOTATE_DOM_SOURCE = `${ANNOTATE_OVERLAY_SOURCE}${String.raw`
var TRAIL_NAME_MAX = ${TRAIL_NAME_MAX};
var TRAIL_ANCESTORS_MAX = ${TRAIL_ANCESTORS_MAX};
var annotate = { picking: false, selecting: false, showMarks: false, revision: 0, marks: [], drafts: [] };
var placed = [];
var placedById = new Map();
var badges = new Map();
var marksParent = null;
var textCache = null;
var indexDirty = true;
var flashMark = null;
var flashTimer = 0;
var relocateTimer = 0;
var selectionTimer = 0;
var lastReported = null;
var reportedSelection = false;
var lastSelectionKey = null;
var selectionPointerDown = false;
var mutationObserver = null;
var pickStart = null;
var hoverBox = null;
var hoverBadge = null;
var hoverBadgeText = "";
var hoverBadgeWidth = 0;
var hoverBadgeHeight = 0;
var hoverElement = null;
var hoverFrame = 0;
var lastPointer = null;
function badgeLeft(left, viewportWidth) {
  if (left >= viewportWidth) return left;
  return Math.max(0, Math.min(left, viewportWidth - BADGE_SIZE));
}
function paintTarget(parent, target, strong) {
  var style = target.boxStyle(strong);
  target.rects().forEach(function (rect) { paintBox(parent, rect, style); });
}
function drawDraft() {
  var parent = layer("draft");
  parent.textContent = "";
  annotate.drafts.forEach(function (anchor) {
    var target = locateAnchor(anchor);
    if (!target) return;
    if (target.kind === "element") {
      target.rects().forEach(function (rect) {
        paintBox(parent, rect, "border-radius:6px;border:2px solid " + ACCENT + ";background:" + ACCENT_FILL);
      });
    } else {
      paintTarget(parent, target, true);
    }
  });
}
function drawFlash() {
  var parent = layer("flash");
  parent.textContent = "";
  var target = flashMark && locateAnchor(flashMark.anchor);
  if (target) paintTarget(parent, target, true);
}
function showOutline(id) {
  var outline = layer("outline");
  outline.textContent = "";
  var entry = placedById.get(id);
  if (entry) paintTarget(outline, entry.target, false);
}
function hideOutline() {
  layer("outline").textContent = "";
}
function badgeOf(event) {
  var badge = event.target && event.target.closest ? event.target.closest("button") : null;
  return badge ? badge.getAttribute("data-id") : null;
}
function marksLayer() {
  if (marksParent) return marksParent;
  marksParent = layer("marks");
  marksParent.addEventListener("click", function (event) {
    var id = badgeOf(event);
    if (id === null) return;
    event.preventDefault();
    post({ method: "coforge/notifications/annotate-activated", params: { id: id } });
  });
  var over = function (event) {
    var id = badgeOf(event);
    if (id !== null) showOutline(id);
  };
  marksParent.addEventListener("pointerover", over);
  marksParent.addEventListener("focusin", over);
  marksParent.addEventListener("pointerout", hideOutline);
  marksParent.addEventListener("focusout", hideOutline);
  return marksParent;
}
function drawMarks() {
  var parent = marksLayer();
  parent.textContent = "";
  badges.clear();
  hideOutline();
  if (!annotate.showMarks) return;
  var measured = placed.map(function (entry) { return { entry: entry, rect: entry.target.rects()[0] }; });
  var taken = {};
  var viewportWidth = document.documentElement.clientWidth;
  measured.forEach(function (item) {
    if (!item.rect) return;
    var mark = item.entry.mark;
    var at = item.entry.target.badgeAt(item.rect);
    var left = badgeLeft(at.left, viewportWidth) + window.scrollX;
    var top = Math.max(0, at.top + window.scrollY);
    var key = Math.round(left / 12) + ":" + Math.round(top / 12);
    while (taken[key]) {
      top += 26;
      key = Math.round(left / 12) + ":" + Math.round(top / 12);
    }
    taken[key] = true;
    var badge = document.createElement("button");
    badge.type = "button";
    badge.setAttribute("data-id", mark.id);
    badge.setAttribute("aria-label", mark.label);
    if (mark.draft) {
      badge.setAttribute("data-draft", "");
      badge.innerHTML = PIN_ICON_SVG;
    } else {
      badge.textContent = String(Math.min(mark.count, 999));
    }
    var look = mark.draft
      ? "border:1px solid " + PIN_BORDER + ";background:" + PIN_BG + ";color:" + PIN_FG + ";border-radius:8px"
      : "border:2px solid " + ACCENT_FG + ";background:" + ACCENT + ";color:" + ACCENT_FG + ";border-radius:" + BADGE_SIZE / 2 + "px";
    badge.style.cssText = "position:absolute;pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;margin:0;padding:0;width:" + BADGE_SIZE + "px;height:" + BADGE_SIZE + "px;" + look + ";font:600 11px/1 var(--coforge-font-sans,system-ui,sans-serif);text-align:center;left:" + left + "px;top:" + top + "px";
    badge.style.boxShadow = flashMark && mark.id === flashMark.id ? BADGE_FLASH_SHADOW : BADGE_SHADOW;
    badges.set(mark.id, badge);
    parent.appendChild(badge);
  });
}
function reportFound() {
  if (annotate.revision === 0) return;
  var ids = placed.map(function (entry) { return entry.mark.id; });
  var key = annotate.revision + ":" + ids.join(",");
  if (key === lastReported) return;
  lastReported = key;
  post({ method: "coforge/notifications/annotate-found", params: { revision: annotate.revision, ids: ids } });
}
function relocate() {
  clearTimeout(relocateTimer);
  relocateTimer = 0;
  if (document.readyState === "loading") return;
  var next = [];
  annotate.marks.forEach(function (mark) {
    var target = locateAnchor(mark.anchor);
    if (target) next.push({ mark: mark, target: target });
  });
  next.sort(function (a, b) {
    if (a.target.node === b.target.node) return 0;
    return a.target.node.compareDocumentPosition(b.target.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  placed = next;
  placedById = new Map(next.map(function (entry) { return [entry.mark.id, entry]; }));
  drawMarks();
  drawDraftPins();
  drawFlash();
  drawDraft();
  if (document.readyState === "complete") reportFound();
}
function scheduleRelocate() {
  if (relocateTimer || (!annotate.marks.length && !annotate.drafts.length && !flashMark)) return;
  relocateTimer = setTimeout(relocate, 150);
}
function ownRecord(record) {
  if (record.target === overlay) return true;
  var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
  return nodes.length > 0 && nodes.every(function (node) { return node === overlay; });
}
function syncWatch() {
  var live = annotate.marks.length > 0 || annotate.drafts.length > 0 || flashMark;
  if (!live) {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = null;
    return;
  }
  if (mutationObserver) return;
  mutationObserver = new MutationObserver(function (records) {
    var changed = false;
    for (var i = 0; i < records.length; i++) {
      if (ownRecord(records[i])) continue;
      changed = true;
      if (records[i].type !== "attributes") indexDirty = true;
    }
    if (changed) scheduleRelocate();
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
}
function setMarks(params) {
  var marks = [];
  var given = params && Array.isArray(params.marks) ? params.marks.slice(0, 500) : [];
  given.forEach(function (mark) {
    if (mark && typeof mark.id === "string" && mark.anchor && typeof mark.label === "string" && Number.isInteger(mark.count)) marks.push({ id: mark.id, anchor: mark.anchor, count: mark.count, label: mark.label.slice(0, 300), draft: mark.draft === true });
  });
  annotate.marks = marks;
  annotate.revision = params && Number.isInteger(params.revision) ? params.revision : 0;
  lastReported = null;
  indexDirty = true;
  syncWatch();
  relocate();
}
function setDraft(params) {
  var next = [];
  if (params && Array.isArray(params.anchors)) {
    params.anchors.slice(0, 20).forEach(function (item) {
      if (item && item.data) next.push(item);
    });
  } else if (params && params.anchor && params.anchor.data) {
    next.push(params.anchor);
  }
  annotate.drafts = next;
  if (next.some(function (item) { return item.type === "text"; })) {
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    indexDirty = true;
  }
  syncWatch();
  drawDraft();
}
function setFlash(mark) {
  var previous = flashMark && badges.get(flashMark.id);
  if (previous) previous.style.boxShadow = BADGE_SHADOW;
  flashMark = mark;
  syncWatch();
  var next = mark && badges.get(mark.id);
  if (next) next.style.boxShadow = BADGE_FLASH_SHADOW;
  drawFlash();
}
function focusMark(params) {
  var entry = placedById.get(params && params.id);
  if (!entry) return;
  var node = entry.target.node;
  var element = node.nodeType === 1 ? node : node.parentElement;
  if (element) element.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  setFlash(entry.mark);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { setFlash(null); }, 1600);
}
function elementUnder(x, y) {
  var stack = document.elementsFromPoint(x, y);
  for (var i = 0; i < stack.length; i++) if (stack[i] !== overlay) return stack[i] === document.documentElement && document.body ? document.body : stack[i];
  return null;
}
function drawHover() {
  hoverFrame = 0;
  var nextElement = lastPointer && elementUnder(lastPointer.x, lastPointer.y);
  if (!nextElement) {
    hideHover();
    return;
  }
  var changed = nextElement !== hoverElement || !hoverBadge;
  hoverElement = nextElement;
  var rect = hoverElement.getBoundingClientRect();
  var viewportWidth = document.documentElement.clientWidth;
  var scrollX = window.scrollX;
  var scrollY = window.scrollY;
  if (hoverBox) placeBox(hoverBox, rect);
  else hoverBox = paintBox(layer("pick-hover"), rect, "border-radius:6px;border:2px solid " + ACCENT + ";background:" + ACCENT_FILL);
  placeHoverBadge(hoverElement, rect, changed, viewportWidth, scrollX, scrollY);
}
function scheduleHover() {
  if (lastPointer && !hoverFrame) hoverFrame = requestAnimationFrame(drawHover);
}
function hideHover() {
  if (hoverFrame) cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  if (hoverBox) hoverBox.remove();
  if (hoverBadge) hoverBadge.remove();
  hoverBox = null;
  hoverBadge = null;
  hoverBadgeText = "";
  hoverBadgeWidth = 0;
  hoverBadgeHeight = 0;
  hoverElement = null;
  lastPointer = null;
}
function stepName(element) {
  var name = element.tagName.toLowerCase();
  if (stableValue(element.id)) name += "#" + element.id;
  else if (element.classList.length > 0) name += "." + element.classList[0];
  return clip(name, TRAIL_NAME_MAX);
}
function ancestorsOf(element) {
  var steps = [];
  var node = element.parentElement;
  while (node && node !== document.body && node !== document.documentElement && steps.length < TRAIL_ANCESTORS_MAX) {
    var data = elementData(node);
    if (data) steps.unshift({ name: stepName(node), data: data, rect: boxOf(node.getBoundingClientRect()) });
    node = node.parentElement;
  }
  return steps;
}
function pickAt(x, y) {
  var target = elementUnder(x, y);
  var data = target && elementData(target);
  if (!data) {
    post({ method: "coforge/notifications/annotate-unanchorable" });
    return;
  }
  post({ method: "coforge/notifications/annotate-selected", params: { type: "element", data: data, rect: boxOf(target.getBoundingClientRect()), name: stepName(target), point: { x: x, y: y }, path: ancestorsOf(target) } });
}
function onOverlay(event) {
  return event.target === overlay;
}
function onPickMove(event) {
  if (onOverlay(event) || event.buttons !== 0) {
    hideHover();
    return;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
  scheduleHover();
}
function onPickOut(event) {
  if (!event.relatedTarget) hideHover();
}
function onPickDown(event) {
  if (onOverlay(event)) return;
  pickStart = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  event.stopImmediatePropagation();
}
function onPickSwallow(event) {
  if (!onOverlay(event)) event.stopImmediatePropagation();
}
function onPickCancel(event) {
  pickStart = null;
  onPickSwallow(event);
}
function onPickClick(event) {
  if (onOverlay(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  var start = pickStart;
  pickStart = null;
  if (!start || Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) return;
  var selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  pickAt(event.clientX, event.clientY);
}
function onPickScroll() {
  scheduleHover();
}
var PICK_LISTENERS = [
  ["pointermove", onPickMove],
  ["pointerout", onPickOut],
  ["pointerdown", onPickDown],
  ["pointerup", onPickSwallow],
  ["pointercancel", onPickCancel],
  ["touchstart", onPickSwallow],
  ["touchend", onPickSwallow],
  ["auxclick", onPickSwallow],
  ["contextmenu", onPickSwallow],
  ["mousedown", onPickSwallow],
  ["mouseup", onPickSwallow],
  ["dblclick", onPickSwallow],
  ["click", onPickClick],
  ["scroll", onPickScroll]
];
function startPicking() {
  annotate.picking = true;
  PICK_LISTENERS.forEach(function (entry) { window.addEventListener(entry[0], entry[1], true); });
}
function stopPicking() {
  annotate.picking = false;
  pickStart = null;
  PICK_LISTENERS.forEach(function (entry) { window.removeEventListener(entry[0], entry[1], true); });
  hideHover();
}
function clearReportedSelection() {
  if (!reportedSelection) return;
  reportedSelection = false;
  lastSelectionKey = null;
  post({ method: "coforge/notifications/annotate-unselected" });
}
function selectionEditable() {
  var active = document.activeElement;
  if (!active) return false;
  return /^(INPUT|TEXTAREA)$/.test(active.tagName) || active.isContentEditable === true;
}
function reportSelection() {
  if (!annotate.selecting) return;
  if (!annotate.picking && selectionEditable()) return clearReportedSelection();
  var selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !document.body) return clearReportedSelection();
  var range = selection.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) return clearReportedSelection();
  indexDirty = true;
  var index = textIndex();
  var span = selectionOffsets(index, range);
  var anchor = span && quoteAnchor(index.text, span.start, span.end);
  if (!anchor) return clearReportedSelection();
  var rect = boxOf(range.getBoundingClientRect());
  if (rect.width === 0 && rect.height === 0) return clearReportedSelection();
  var key = anchor.quote + "|" + Math.round(rect.left) + "|" + Math.round(rect.top) + "|" + Math.round(rect.width) + "|" + Math.round(rect.height);
  if (reportedSelection && key === lastSelectionKey) return;
  reportedSelection = true;
  lastSelectionKey = key;
  post({ method: "coforge/notifications/annotate-selected", params: { type: "text", data: anchor, rect: rect } });
}
function scheduleSelection(delay) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(reportSelection, delay || 0);
}
function setMode(params) {
  var next = params || {};
  if ((next.picking === true) !== annotate.picking) {
    if (next.picking === true) startPicking();
    else stopPicking();
  }
  annotate.selecting = next.selecting === true;
  if (!annotate.selecting) {
    reportedSelection = false;
    lastSelectionKey = null;
  }
  var showMarks = next.showMarks === true;
  if (showMarks !== annotate.showMarks) {
    annotate.showMarks = showMarks;
    drawMarks();
    drawDraftPins();
  }
  post({ method: "coforge/notifications/annotate-mode", params: { picking: annotate.picking } });
}
function annotateMessage(method, params) {
  switch (method) {
    case "coforge/annotate/mode": setMode(params); return true;
    case "coforge/annotate/marks": setMarks(params); return true;
    case "coforge/annotate/focus": focusMark(params); return true;
    case "coforge/annotate/draft": setDraft(params); return true;
    default: return false;
  }
}
function startAnnotations() {
  window.addEventListener("pointerdown", function () { selectionPointerDown = true; }, true);
  window.addEventListener("pointercancel", function () { selectionPointerDown = false; }, true);
  window.addEventListener("pointerup", function () { selectionPointerDown = false; scheduleSelection(0); }, true);
  window.addEventListener("mouseup", function () { selectionPointerDown = false; scheduleSelection(0); }, true);
  window.addEventListener("keydown", function (event) {
    if (!annotate.selecting || !event.isTrusted || event.isComposing || event.repeat) return;
    if ((event.metaKey || event.ctrlKey) && event.altKey && (event.code === "KeyM" || String(event.key).toLowerCase() === "m")) {
      reportSelection();
      if (reportedSelection) {
        event.preventDefault();
        post({ method: "coforge/notifications/annotate-compose", params: {} });
      }
    }
  }, true);
  window.addEventListener("keyup", function (event) {
    if (event.shiftKey || /^(Arrow|Home$|End$|Page)/.test(event.key) || ((event.ctrlKey || event.metaKey) && event.key === "a")) reportSelection();
  }, true);
  document.addEventListener("selectionchange", function () {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (reportedSelection) clearReportedSelection();
      return;
    }
    if (annotate.selecting && !selectionPointerDown) scheduleSelection(80);
  });
  window.addEventListener("resize", scheduleRelocate);
  window.addEventListener("load", scheduleRelocate);
  document.addEventListener("DOMContentLoaded", relocate);
}
`}`;
