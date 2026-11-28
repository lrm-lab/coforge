export function isInsideViewportScroller(element, viewportWidth, getStyle) {
  const readStyle = getStyle ?? getComputedStyle;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const cs = readStyle(parent);
    const overflowX = cs.overflowX;
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      parent.scrollWidth > parent.clientWidth + 1
    ) {
      const rect = parent.getBoundingClientRect();
      return rect.left >= -2 && rect.right <= viewportWidth + 2;
    }
    if ((overflowX === "hidden" || overflowX === "clip") && cs.textOverflow === "ellipsis") {
      const rect = parent.getBoundingClientRect();
      return rect.left >= -2 && rect.right <= viewportWidth + 2;
    }
  }
  return false;
}

export function isHiddenOffscreenLayer(element, viewportWidth, getStyle) {
  const readStyle = getStyle ?? getComputedStyle;
  let hiddenEl = null;
  for (let cur = element; cur; cur = cur.parentElement) {
    const tag = cur.tagName?.toLowerCase();
    if (cur.inert || (cur.getAttribute?.("aria-hidden") === "true" && tag !== "svg")) {
      hiddenEl = cur;
      break;
    }
  }
  if (!hiddenEl) return false;
  for (let parent = hiddenEl.parentElement; parent; parent = parent.parentElement) {
    const overflowX = readStyle(parent).overflowX;
    if (overflowX === "hidden" || overflowX === "clip") {
      const rect = parent.getBoundingClientRect();
      if (rect.left >= -2 && rect.right <= viewportWidth + 2) return true;
    }
  }
  return false;
}

export function hasCompleteDialogOverlay(
  dialog,
  allElements,
  viewportWidth,
  viewportHeight,
  getStyle,
) {
  const readStyle = getStyle ?? getComputedStyle;
  const coversViewport = (el) => {
    const style = readStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity) === 0
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return (
      r.left <= 1 && r.top <= 1 && r.right >= viewportWidth - 1 && r.bottom >= viewportHeight - 1
    );
  };
  let pageFlow = null;
  if (typeof dialog.closest === "function") {
    pageFlow = dialog.closest("[data-phone-page-flow]");
  } else {
    for (let cur = dialog; cur; cur = cur.parentElement) {
      if (
        cur.hasAttribute?.("data-phone-page-flow") ||
        Boolean(cur.dataset && "phonePageFlow" in cur.dataset)
      ) {
        pageFlow = cur;
        break;
      }
    }
  }
  if (pageFlow && coversViewport(pageFlow)) return true;
  for (const el of allElements) {
    if (el === dialog || (typeof dialog.contains === "function" && dialog.contains(el))) continue;
    const style = readStyle(el);
    const isScrim =
      style.position === "fixed" ||
      (style.position === "absolute" &&
        (el.hasAttribute?.("data-page-scrim") || Boolean(el.dataset && "pageScrim" in el.dataset)));
    if (!isScrim) continue;
    if (coversViewport(el)) return true;
  }
  return false;
}

export function filterSweepOptions(values, filter, label) {
  if (!filter) return values;
  const requested = new Set(
    filter
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selected = values.filter((value) => requested.has(value.name ?? value));
  if (selected.length !== requested.size) {
    throw new Error(`Unknown ${label} filter: ${filter}`);
  }
  return selected;
}

export function resolveHorizontalDividerRule(rect, style, beforeStyle) {
  const round10 = (v) => Math.round(v * 10) / 10;
  const isOpaqueColor = (color) =>
    Boolean(color) &&
    color !== "transparent" &&
    !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color) &&
    !/\/\s*0(?:\.0+)?\s*\)$/.test(color);
  const hasBottomBorder =
    (parseFloat(style.borderBottomWidth) || 0) > 0 && isOpaqueColor(style.borderBottomColor);
  const hasBefore =
    Boolean(beforeStyle) &&
    beforeStyle.content !== "none" &&
    beforeStyle.display !== "none" &&
    (((parseFloat(beforeStyle.borderTopWidth) || 0) > 0 &&
      isOpaqueColor(beforeStyle.borderTopColor)) ||
      ((parseFloat(beforeStyle.borderBottomWidth) || 0) > 0 &&
        isOpaqueColor(beforeStyle.borderBottomColor)) ||
      ((parseFloat(beforeStyle.height) || 0) > 0 &&
        (parseFloat(beforeStyle.height) || 0) <= 2 &&
        isOpaqueColor(beforeStyle.backgroundColor)));
  let beforeRuleY = null;
  if (hasBefore) {
    const lineH =
      parseFloat(beforeStyle.borderTopWidth) ||
      parseFloat(beforeStyle.borderBottomWidth) ||
      parseFloat(beforeStyle.height) ||
      1;
    const topOff = parseFloat(beforeStyle.top);
    const bottomOff = parseFloat(beforeStyle.bottom);
    if (beforeStyle.top !== "auto" && Number.isFinite(topOff)) {
      beforeRuleY = round10(rect.top + topOff + lineH);
    } else if (beforeStyle.bottom !== "auto" && Number.isFinite(bottomOff)) {
      beforeRuleY = round10(rect.bottom - bottomOff);
    }
  }
  return { hasBottomBorder, beforeRuleY };
}

export function findPaneHeaderMisalignments(
  panes,
  {
    viewportWidth = 1440,
    expectedHeaderHeight = 48,
    expectedSubbarHeight = 36,
    tolerance = 0.5,
  } = {},
) {
  const findings = [];
  const round10 = (v) => Math.round(v * 10) / 10;
  const near = (a, b) => Math.abs(a - b) <= tolerance;
  const push = (pane, detail) => {
    findings.push({
      check: "pane-header-divider-misaligned",
      detail,
      locator: pane.locator ?? null,
    });
  };

  for (const pane of panes) {
    if (!pane.borderless && !pane.row1HasDivider) {
      push(pane, "missing Row 1 divider border on pane header");
    }
    if (pane.hasSubbar && !pane.row2HasDivider) {
      push(pane, "missing Row 2 divider border on pane subbar");
    }
    if (
      pane.hasSubbar &&
      pane.row1Y != null &&
      pane.subbarTop != null &&
      !near(pane.subbarTop, pane.row1Y)
    ) {
      push(pane, `subbar starts at y=${pane.subbarTop} instead of Row 1 divider y=${pane.row1Y}`);
    }
    const mobileMultilineExempt = viewportWidth < 640 && pane.multilineMobile;
    if (!mobileMultilineExempt) {
      const row1Bottom = pane.row1Y ?? pane.bottom;
      const row1Height = round10(row1Bottom - pane.top);
      if (!near(row1Height, expectedHeaderHeight)) {
        push(pane, `Row 1 height ${row1Height}px != expected ${expectedHeaderHeight}px`);
      }
      if (pane.hasSubbar) {
        const expectedTotal = expectedHeaderHeight + expectedSubbarHeight;
        if (!near(pane.totalHeight, expectedTotal)) {
          push(
            pane,
            `header+subbar totalHeight ${pane.totalHeight}px != expected ${expectedTotal}px`,
          );
        }
      }
    }
  }

  const ordered = [...panes].sort((a, b) => a.left - b.left || a.top - b.top);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (Math.abs(a.top - b.top) > 1) continue;
      if (a.right > b.left + 2) continue;
      const hasIntervening = ordered.some(
        (mid, k) =>
          k !== i &&
          k !== j &&
          Math.abs(mid.top - a.top) <= 1 &&
          mid.left >= a.right - 2 &&
          mid.right <= b.left + 2,
      );
      if (hasIntervening) continue;

      if (a.row1Y != null && b.row1Y != null && !near(a.row1Y, b.row1Y)) {
        push(
          b,
          `adjacent Row 1 dividers misaligned (${a.locator ?? "left"}=${a.row1Y} vs ${b.locator ?? "right"}=${b.row1Y})`,
        );
      }
      if (
        a.hasSubbar &&
        b.hasSubbar &&
        a.row2Y != null &&
        b.row2Y != null &&
        !near(a.row2Y, b.row2Y)
      ) {
        push(
          b,
          `adjacent Row 2 dividers misaligned (${a.locator ?? "left"}=${a.row2Y} vs ${b.locator ?? "right"}=${b.row2Y})`,
        );
      }
    }
  }

  return findings;
}

export function isTextEntryElement(element) {
  const nonTextInputTypes = new Set([
    "checkbox",
    "radio",
    "range",
    "color",
    "file",
    "button",
    "submit",
    "reset",
    "image",
    "hidden",
  ]);
  const tag = String(element?.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = String(
      (element.getAttribute ? element.getAttribute("type") : undefined) ?? element.type ?? "text",
    ).toLowerCase();
    return !nonTextInputTypes.has(type);
  }
  const contentEditable = element?.getAttribute
    ? element.getAttribute("contenteditable")
    : element?.contenteditable;
  return contentEditable !== null && contentEditable !== undefined && contentEditable !== "false";
}

export function isTouchZoomRiskFontSize(fontSizePx) {
  return Number.isFinite(fontSizePx) && fontSizePx < 16;
}
