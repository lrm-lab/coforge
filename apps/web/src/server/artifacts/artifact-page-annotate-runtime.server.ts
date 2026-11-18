import {
  TRAIL_ANCESTORS_MAX,
  TRAIL_NAME_MAX,
} from "#src/features/artifacts/artifact-page-annotations";

export const ANNOTATE_DOM_SOURCE = String.raw`
var TRAIL_NAME_MAX = ${TRAIL_NAME_MAX};
var TRAIL_ANCESTORS_MAX = ${TRAIL_ANCESTORS_MAX};
var ACCENT = "#7f56d9";
var annotate = { picking: false, selecting: false, showMarks: false, revision: 0, marks: [], draft: null };
var BADGE_SHADOW = "0 1px 3px rgba(0,0,0,.35)";
var BADGE_FLASH_SHADOW = BADGE_SHADOW + ",0 0 0 5px rgba(127,86,217,.4)";
var placed = [];
var placedById = new Map();
var badges = new Map();
var marksParent = null;
var textCache = null;
var indexDirty = true;
var flashId = null;
var flashTimer = 0;
var relocateTimer = 0;
var lastReported = null;
var reportedSelection = false;
var mutationObserver = null;
var pickStart = null;
var hoverBox = null;
var hoverElement = null;
var hoverFrame = 0;
var lastPointer = null;
function paintTarget(parent, target, strong) {
  var style = target.boxStyle(strong);
  target.rects().forEach(function (rect) { paintBox(parent, rect, style); });
}
function drawDraft() {
  var parent = layer("draft");
  parent.textContent = "";
  var target = annotate.draft && locateAnchor(annotate.draft);
  if (target) paintTarget(parent, target, true);
}
function drawFlash() {
  var parent = layer("flash");
  parent.textContent = "";
  var entry = flashId === null ? null : placedById.get(flashId);
  if (entry) paintTarget(parent, entry.target, true);
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
  measured.forEach(function (item) {
    if (!item.rect) return;
    var mark = item.entry.mark;
    var at = item.entry.target.badgeAt(item.rect);
    var left = Math.max(0, at.left + window.scrollX);
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
    badge.textContent = mark.draft ? "" : String(Math.min(mark.count, 999));
    badge.setAttribute("aria-label", mark.label);
    if (mark.draft) badge.setAttribute("data-draft", "");
    var look = mark.draft ? "border:2px dashed " + ACCENT + ";background:#fff" : "border:2px solid #fff;background:" + ACCENT;
    badge.style.cssText = "position:absolute;pointer-events:auto;cursor:pointer;margin:0;padding:0;width:24px;height:24px;border-radius:12px;" + look + ";color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center;left:" + left + "px;top:" + top + "px";
    badge.style.boxShadow = mark.id === flashId ? BADGE_FLASH_SHADOW : BADGE_SHADOW;
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
  drawFlash();
  drawDraft();
  if (document.readyState === "complete") reportFound();
}
function scheduleRelocate() {
  if (relocateTimer || (!annotate.marks.length && !annotate.draft)) return;
  relocateTimer = setTimeout(relocate, 150);
}
function ownRecord(record) {
  if (record.target === overlay) return true;
  var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
  return nodes.length > 0 && nodes.every(function (node) { return node === overlay; });
}
function syncWatch() {
  var live = annotate.marks.length > 0 || annotate.draft !== null;
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
  annotate.draft = params && params.anchor && params.anchor.data ? params.anchor : null;
  if (annotate.draft && annotate.draft.type === "text") {
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    indexDirty = true;
  }
  syncWatch();
  drawDraft();
}
function setFlash(id) {
  var previous = flashId === null ? null : badges.get(flashId);
  if (previous) previous.style.boxShadow = BADGE_SHADOW;
  flashId = id;
  var next = id === null ? null : badges.get(id);
  if (next) next.style.boxShadow = BADGE_FLASH_SHADOW;
  drawFlash();
}
function focusMark(params) {
  var entry = placedById.get(params && params.id);
  if (!entry) return;
  var node = entry.target.node;
  var element = node.nodeType === 1 ? node : node.parentElement;
  if (element) element.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  setFlash(entry.mark.id);
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
  hoverElement = lastPointer && elementUnder(lastPointer.x, lastPointer.y);
  if (!hoverElement) {
    hideHover();
    return;
  }
  var rect = hoverElement.getBoundingClientRect();
  if (hoverBox) placeBox(hoverBox, rect);
  else hoverBox = paintBox(layer("pick-hover"), rect, "border-radius:3px;border:2px solid " + ACCENT + ";background:rgba(127,86,217,.12)");
}
function scheduleHover() {
  if (lastPointer && !hoverFrame) hoverFrame = requestAnimationFrame(drawHover);
}
function hideHover() {
  if (hoverFrame) cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  if (hoverBox) hoverBox.remove();
  hoverBox = null;
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
  post({ method: "coforge/notifications/annotate-unselected" });
}
function reportSelection() {
  if (!annotate.selecting) return;
  var selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !document.body) return clearReportedSelection();
  var range = selection.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) return clearReportedSelection();
  indexDirty = true;
  var index = textIndex();
  var span = selectionOffsets(index, range);
  var anchor = span && quoteAnchor(index.text, span.start, span.end);
  if (!anchor) return clearReportedSelection();
  reportedSelection = true;
  post({ method: "coforge/notifications/annotate-selected", params: { type: "text", data: anchor, rect: boxOf(range.getBoundingClientRect()) } });
}
function setMode(params) {
  var next = params || {};
  if ((next.picking === true) !== annotate.picking) {
    if (next.picking === true) startPicking();
    else stopPicking();
  }
  annotate.selecting = next.selecting === true;
  if (!annotate.selecting) reportedSelection = false;
  var showMarks = next.showMarks === true;
  if (showMarks !== annotate.showMarks) {
    annotate.showMarks = showMarks;
    drawMarks();
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
  window.addEventListener("pointerup", function () { setTimeout(reportSelection, 0); }, true);
  window.addEventListener("keyup", function (event) {
    if (event.shiftKey || /^(Arrow|Home$|End$|Page)/.test(event.key) || ((event.ctrlKey || event.metaKey) && event.key === "a")) reportSelection();
  }, true);
  document.addEventListener("selectionchange", function () {
    var selection = window.getSelection();
    if (reportedSelection && (!selection || selection.isCollapsed)) clearReportedSelection();
  });
  window.addEventListener("resize", scheduleRelocate);
  window.addEventListener("load", scheduleRelocate);
  document.addEventListener("DOMContentLoaded", relocate);
}
`;
