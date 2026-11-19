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

  const scrollWidth = document.documentElement.scrollWidth;
  const clientWidth = document.documentElement.clientWidth;
  if (scrollWidth > clientWidth + 1) {
    findings.push({ check: "horizontal-overflow", detail: \`scrollWidth \${scrollWidth} > clientWidth \${clientWidth}\` });
  }

  const all = document.querySelectorAll("body *");

  const DECLARED_VERTICAL_ONLY_SCROLLER = /(^|\\s)overflow-y-(auto|scroll)(\\s|$)/;
  let sidewaysScrollerCount = 0;
  for (const el of all) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!DECLARED_VERTICAL_ONLY_SCROLLER.test(cls) || /(^|\\s)overflow-x-(auto|scroll)(\\s|$)/.test(cls)) continue;
    if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1 || sidewaysScrollerCount >= 8) continue;
    findings.push({ check: "vertical-list-scrolls-sideways", detail: \`scrollWidth \${el.scrollWidth} > clientWidth \${el.clientWidth}\`, locator: locator(el) });
    sidewaysScrollerCount++;
  }
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

  const h1 = document.querySelector("h1");
  const overlayOpen = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
  if (!h1) {
    findings.push({ check: "missing-h1", detail: "no <h1> found on the page" });
  } else if (!overlayOpen) {
    const h1Rect = h1.getBoundingClientRect();
    let overlapCount = 0;
    for (const el of all) {
      if (el === h1 || el.contains(h1) || h1.contains(el)) continue;
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

  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const dr = dialog.getBoundingClientRect();
    const isLikelyModal = dr.width * dr.height > vw * vh * 0.3;
    if (!isLikelyModal) {
      if (dr.left < -1 || dr.top < -1 || dr.right > vw + 1 || dr.bottom > vh + 1) {
        findings.push({ check: "popover-outside-viewport", detail: \`rect=\${Math.round(dr.left)},\${Math.round(dr.top)},\${Math.round(dr.right)},\${Math.round(dr.bottom)} viewport=\${vw}x\${vh}\`, locator: locator(dialog) });
      }
      continue;
    }
    let coveringOverlay = null;
    for (const el of all) {
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
