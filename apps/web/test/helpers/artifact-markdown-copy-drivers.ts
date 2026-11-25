import { animationsSettled, browserSession, pageDevtools } from "./browser-e2e";

export const isMac = process.platform === "darwin";
export const modKey = isMac ? "Meta" : "Control";
export const cdpMod = isMac ? 4 : 2;

export function createArtifactCopyDrivers(session: ReturnType<typeof browserSession>) {
  const { browser, evaluate } = session;

  const dragPoints = async (startSelector: string, endSelector: string, steps = 8) => {
    await browser("wait", "--fn", animationsSettled());
    const box = await evaluate<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    }>(`(() => {
      const a = document.querySelector(${JSON.stringify(startSelector)});
      const b = document.querySelector(${JSON.stringify(endSelector)});
      a.scrollIntoView({ block: "start" });
      const scroller = a.closest(".overflow-auto");
      if (scroller && scroller.scrollTop > 0) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 64);
      }
      const r1 = a.getBoundingClientRect();
      const r2 = b.getBoundingClientRect();
      return {
        start: {
          x: Math.max(4, Math.floor(r1.left) - 4),
          y: Math.round(r1.top + Math.min(r1.height / 2, 12)),
        },
        end: {
          x: Math.round(r2.right - 2),
          y: Math.round(r2.bottom - Math.min(r2.height / 2, 8)),
        },
      };
    })()`);
    await browser(
      "mouse",
      "move",
      String(Math.round(box.start.x)),
      String(Math.round(box.start.y)),
    );
    await browser("mouse", "down");
    for (let step = 1; step <= steps; step++) {
      const x = box.start.x + ((box.end.x - box.start.x) * step) / steps;
      const y = box.start.y + ((box.end.y - box.start.y) * step) / steps;
      await browser("mouse", "move", String(Math.round(x)), String(Math.round(y)));
    }
    await browser("mouse", "up");
  };

  const clickPoint = async (x: number, y: number) => {
    await browser("mouse", "move", String(Math.round(x)), String(Math.round(y)));
    await browser("mouse", "down");
    await browser("mouse", "up");
  };

  const clickElement = async (selector: string) => {
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + Math.min(r.width / 2, 40)),
        y: Math.round(r.top + r.height / 2),
      };
    })()`);
    await clickPoint(point.x, point.y);
  };

  const readCopiedViaRealPaste = async (cdp: Awaited<ReturnType<typeof pageDevtools>>) => {
    await evaluate(`(() => {
      document.getElementById("__e2e_paste_target")?.remove();
      const target = document.createElement("div");
      target.id = "__e2e_paste_target";
      target.contentEditable = "true";
      target.style.cssText =
        "position:fixed;left:0;top:0;width:16px;height:16px;opacity:0;z-index:99999";
      document.body.appendChild(target);
      window.__e2ePasteResult = null;
      target.addEventListener(
        "paste",
        (event) => {
          window.__e2ePasteResult = {
            html: event.clipboardData?.getData("text/html") ?? "",
            plain: event.clipboardData?.getData("text/plain") ?? "",
          };
          event.preventDefault();
        },
        { once: true },
      );
      return true;
    })()`);
    try {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "c",
        code: "KeyC",
        modifiers: cdpMod,
        commands: ["copy"],
      });
      await evaluate(`(() => {
        const target = document.getElementById("__e2e_paste_target");
        if (!target) return false;
        target.focus();
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(target);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      })()`);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "v",
        code: "KeyV",
        modifiers: cdpMod,
        commands: ["paste"],
      });
      await browser("wait", "--fn", `window.__e2ePasteResult != null`);
      return await evaluate<{ html: string; plain: string }>(`window.__e2ePasteResult`);
    } finally {
      await evaluate(
        `(document.getElementById("__e2e_paste_target")?.remove(), delete window.__e2ePasteResult, true)`,
      ).catch(() => undefined);
    }
  };

  const pressModAAndCheckIntercepted = async () => {
    await evaluate(`(() => {
      window.__e2eModADefaultPrevented = null;
      if (window.__e2eModAListener) {
        window.removeEventListener("keydown", window.__e2eModAListener);
      }
      window.__e2eModAListener = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          window.__e2eModADefaultPrevented = event.defaultPrevented;
        }
      };
      window.addEventListener("keydown", window.__e2eModAListener);
      return true;
    })()`);
    try {
      await browser("press", `${modKey}+a`);
      await browser("wait", "--fn", `window.__e2eModADefaultPrevented !== null`);
      return await evaluate<{ intercepted: boolean; text: string; inMarkdown: boolean }>(`(() => {
        const sel = window.getSelection();
        const md =
          document.querySelector("main [data-artifact-markdown]") ??
          document.querySelector("[data-artifact-preview] [data-artifact-markdown]");
        return {
          intercepted: Boolean(window.__e2eModADefaultPrevented),
          text: sel?.toString() ?? "",
          inMarkdown: Boolean(
            sel &&
              !sel.isCollapsed &&
              sel.rangeCount > 0 &&
              md?.contains(sel.getRangeAt(0).commonAncestorContainer),
          ),
        };
      })()`);
    } finally {
      await evaluate(`(() => {
        if (window.__e2eModAListener) {
          window.removeEventListener("keydown", window.__e2eModAListener);
          delete window.__e2eModAListener;
        }
        delete window.__e2eModADefaultPrevented;
        return true;
      })()`).catch(() => undefined);
    }
  };

  return {
    dragPoints,
    clickPoint,
    clickElement,
    readCopiedViaRealPaste,
    pressModAAndCheckIntercepted,
  };
}
