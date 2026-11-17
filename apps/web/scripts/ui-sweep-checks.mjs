// The in-page layout checks ui-sweep.mjs runs on every capture, as one script for Runtime.evaluate.

import { isInsideViewportScroller } from "./ui-sweep-helpers.mjs";

const FORBIDDEN_CLASS_PATTERNS = [
  {
    re: /(^|\s)text-muted-foreground(\s|$)/,
    label: "text-muted-foreground (shadcn token, not ours)",
  },
  { re: /(^|\s)bg-muted(\s|$)/, label: "bg-muted (shadcn token, not ours)" },
  { re: /(^|\s)bg-card(\s|$)/, label: "bg-card (shadcn token, not ours)" },
  {
    re: /(^|\s)dark:[a-z-]+-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(\s|$)/,
    label: "dark: prefix with a literal Tailwind color (should be a semantic token)",
  },
];

// ---------------------------------------------------------------------------
// In-page automatic layout checks (one Runtime.evaluate round-trip).
// ---------------------------------------------------------------------------
export const CHECKS_EXPR = `
(() => {
  const findings = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isInsideViewportScroller = ${isInsideViewportScroller.toString()};

  function locator(el) {
    if (!el) return null;
    const id = el.id ? "#" + el.id : "";
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    const text = (el.textContent || "").trim().slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : "");
  }

  // 1. horizontal overflow
  const scrollWidth = document.documentElement.scrollWidth;
  const clientWidth = document.documentElement.clientWidth;
  if (scrollWidth > clientWidth + 1) {
    findings.push({ check: "horizontal-overflow", detail: \`scrollWidth \${scrollWidth} > clientWidth \${clientWidth}\` });
  }

  // 2. elements exceeding viewport horizontally + 3. clipped text
  const all = document.querySelectorAll("body *");
  let oversizedCount = 0;
  let clippedCount = 0;
  for (const el of all) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.right > vw + 2 &&
      !isInsideViewportScroller(el, vw) &&
      oversizedCount < 8
    ) {
      findings.push({ check: "element-exceeds-viewport", detail: \`right=\${Math.round(rect.right)} viewport=\${vw}\`, locator: locator(el) });
      oversizedCount++;
    }
    // Ellipsis truncation (Tailwind's "truncate" utility) is this app's
    // deliberate, affordanced way to shorten text in a tight container —
    // only flag a hard clip with no such affordance as a real defect.
    if (
      el.children.length === 0 &&
      el.textContent &&
      el.textContent.trim() &&
      el.clientWidth > 8 &&
      el.scrollWidth > el.clientWidth + 2 &&
      style.textOverflow !== "ellipsis" &&
      clippedCount < 8
    ) {
      findings.push({ check: "clipped-text", detail: \`scrollWidth=\${el.scrollWidth} clientWidth=\${el.clientWidth}\`, locator: locator(el) });
      clippedCount++;
    }
  }

  // 4. fixed elements overlapping the page <h1>: a floating bar or banner over the title. An
  // absolutely positioned piece belongs to its component (an avatar's sticker beside a DM's
  // title reaches into the title's box without covering a letter), so it is not counted.
  const h1 = document.querySelector("h1");
  // While a dialog, menu or listbox is open the page under it, <h1> included, is covered by
  // design (its underlay is a transparent fixed layer over everything).
  const overlayOpen = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
  if (!h1) {
    findings.push({ check: "missing-h1", detail: "no <h1> found on the page" });
  } else if (!overlayOpen) {
    const h1Rect = h1.getBoundingClientRect();
    let overlapCount = 0;
    for (const el of all) {
      if (el === h1 || el.contains(h1) || h1.contains(el)) continue;
      // A modal dialog/menu legitimately covers the whole page, including the
      // <h1>, while it is open — that is not a layout defect, so skip any
      // fixed/absolute wrapper that contains one.
      if (el.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed") continue;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const overlaps = !(r.right <= h1Rect.left || r.left >= h1Rect.right || r.bottom <= h1Rect.top || r.top >= h1Rect.bottom);
      if (overlaps && overlapCount < 5) {
        findings.push({ check: "overlaps-h1", detail: "fixed element overlaps the page <h1>", locator: locator(el) });
        overlapCount++;
      }
    }
  }

  // 5. buttons/inputs inside headers smaller than 24px tall, the smallest target WCAG 2.2 allows
  // (2.5.8). Bigger is never a defect: a header holds avatar stacks (24px) and an account
  // photo button (101px) by design.
  const headers = document.querySelectorAll("header");
  let headerControlCount = 0;
  for (const header of headers) {
    const controls = header.querySelectorAll('button, input, [role="button"]');
    for (const el of controls) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height < 24 && headerControlCount < 8) {
        findings.push({ check: "header-control-size", detail: \`height=\${Math.round(r.height)}px (at least 24px)\`, locator: locator(el) });
        headerControlCount++;
      }
    }
  }

  // 6. dialogs whose overlay does not cover the full viewport
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const dr = dialog.getBoundingClientRect();
    // A popover/tooltip is a small dialog — only check overlay coverage for
    // larger, modal-shaped dialogs (roughly > 30% of viewport area).
    const isLikelyModal = dr.width * dr.height > vw * vh * 0.3;
    if (!isLikelyModal) {
      // 7. popovers extending outside the viewport
      if (dr.left < -1 || dr.top < -1 || dr.right > vw + 1 || dr.bottom > vh + 1) {
        findings.push({ check: "popover-outside-viewport", detail: \`rect=\${Math.round(dr.left)},\${Math.round(dr.top)},\${Math.round(dr.right)},\${Math.round(dr.bottom)} viewport=\${vw}x\${vh}\`, locator: locator(dialog) });
      }
      continue;
    }
    let coveringOverlay = null;
    for (const el of all) {
      // Exclude the dialog and anything inside it; an ancestor wrapper is a
      // valid (and common) place for the backdrop to live, so it stays in.
      if (el === dialog || dialog.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed") continue;
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.left <= 1 && r.top <= 1 && r.right >= vw - 1 && r.bottom >= vh - 1) { coveringOverlay = el; break; }
    }
    if (!coveringOverlay) {
      findings.push({ check: "dialog-overlay-incomplete", detail: "no fixed element found covering the full viewport behind this dialog", locator: locator(dialog) });
    }
  }

  // 8. forbidden classes / hex colors in style
  const forbidden = ${JSON.stringify(FORBIDDEN_CLASS_PATTERNS.map((p) => p.re.source))};
  const forbiddenLabels = ${JSON.stringify(FORBIDDEN_CLASS_PATTERNS.map((p) => p.label))};
  let forbiddenCount = 0;
  let hexCount = 0;
  const isDark = document.documentElement.classList.contains("dark-mode") || document.documentElement.classList.contains("dark");
  for (const el of all) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (cls) {
      for (let i = 0; i < forbidden.length; i++) {
        const label = forbiddenLabels[i];
        if (label.startsWith("dark:") ) { /* handled below with isDark gate for bg-brand-primary only */ }
        const re = new RegExp(forbidden[i]);
        if (re.test(cls) && forbiddenCount < 10) {
          findings.push({ check: "forbidden-class", detail: label, locator: locator(el) });
          forbiddenCount++;
        }
      }
      if (isDark && /(^|\\s)bg-brand-primary(\\s|$)/.test(cls) && forbiddenCount < 10) {
        findings.push({ check: "forbidden-class", detail: "bg-brand-primary used in dark mode", locator: locator(el) });
        forbiddenCount++;
      }
    }
    const inlineStyle = el.getAttribute("style");
    if (inlineStyle && /#[0-9a-fA-F]{3,8}\\b/.test(inlineStyle) && hexCount < 10) {
      findings.push({ check: "hex-color-in-style", detail: inlineStyle.slice(0, 120), locator: locator(el) });
      hexCount++;
    }
  }

  // sidebar width (best effort)
  let sidebarWidth = null;
  const marker = document.querySelector('[aria-label="Resize sidebar"], [aria-label*="Current workspace"]');
  let walker = marker;
  while (walker) {
    const cs = getComputedStyle(walker);
    if (cs.position === "fixed" || walker.tagName === "NAV" || walker.tagName === "ASIDE") {
      sidebarWidth = Math.round(walker.getBoundingClientRect().width);
      break;
    }
    walker = walker.parentElement;
  }

  return {
    findings,
    hasH1: !!h1,
    sidebarWidth,
    dialogCount: dialogs.length,
  };
})()
`;
