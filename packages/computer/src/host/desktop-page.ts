const RELATIVE_PAGE_SCRIPT = `
    import RFB from "./core/rfb.js";

    const msg = document.getElementById("msg");
    const screen = document.getElementById("screen");
    const params = new URLSearchParams(location.search);
    const phone = params.get("view") === "phone";
    const token = params.get("token") || "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = location.pathname.replace(/\\/desktop\\.html$/, "").replace(/\\/+$/, "");
    const query = token ? \`?token=\${encodeURIComponent(token)}\` : "";
    const url = \`\${proto}://\${location.host}\${base}/websockify\${query}\`;
    const reconnect = document.getElementById("coforge-desktop-reconnect");
    const phoneBar = document.getElementById("coforge-desktop-phone-bar");
    const showReconnect = (visible) => {
      reconnect?.classList.toggle("is-visible", visible);
    };
    const KEYSYMS = {
      Escape: 0xff1b,
      Tab: 0xff09,
      ControlLeft: 0xffe3,
      ArrowLeft: 0xff51,
      ArrowUp: 0xff52,
      ArrowRight: 0xff53,
      ArrowDown: 0xff54,
    };
    let phoneMode = "fit";
    let ctrlHeld = false;
    let gesturesBound = false;
    function applyPhoneMode(mode) {
      if (!rfb || !phone) return;
      phoneMode = mode;
      if (mode === "pan") {
        rfb.scaleViewport = false;
        rfb.clipViewport = true;
        rfb.dragViewport = true;
      } else {
        rfb.scaleViewport = true;
        rfb.clipViewport = false;
        rfb.dragViewport = false;
      }
      phoneBar?.querySelectorAll("button[data-mode]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.mode === mode);
      });
    }
    function sendKey(code, down) {
      if (!rfb) return;
      const keysym = KEYSYMS[code];
      if (keysym === undefined) return;
      try {
        rfb.sendKey(keysym, code, down);
      } catch {
      }
    }
    function sendKeysym(keysym, code = "Unidentified") {
      if (!rfb) return;
      try {
        rfb.sendKey(keysym, code, true);
        rfb.sendKey(keysym, code, false);
      } catch {
      }
    }
    function sendTypedCharacter(ch) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) return;
      sendKeysym(cp < 0x100 ? cp : 0x01000000 + cp);
    }
    function coforgeAttachPhoneKeyboard() {
      const kbInput = document.getElementById("coforge-desktop-keyboard-input");
      const kbButton = phoneBar?.querySelector('button[data-action="keyboard"]');
      if (!phone || !kbInput || !kbButton || kbInput.dataset.bound === "1") return;
      kbInput.dataset.bound = "1";
      const openKeyboard = () => {
        try {
          kbInput.focus({ preventScroll: true });
        } catch {
          kbInput.focus();
        }
        kbButton.classList.add("is-active");
      };
      kbButton.addEventListener("click", (ev) => {
        ev.preventDefault();
        openKeyboard();
      });
      kbInput.addEventListener("focus", () => kbButton.classList.add("is-active"));
      kbInput.addEventListener("blur", () => kbButton.classList.remove("is-active"));
      kbInput.addEventListener("keydown", (ev) => {
        if (!rfb) return;
        if (ev.key === "Backspace") {
          ev.preventDefault();
          sendKeysym(0xff08, "Backspace");
          return;
        }
        if (ev.key === "Enter") {
          ev.preventDefault();
          sendKeysym(0xff0d, "Enter");
          return;
        }
        if (ev.key === "Tab") {
          ev.preventDefault();
          sendKey("Tab", true);
          sendKey("Tab", false);
        }
      });
      kbInput.addEventListener("input", () => {
        const text = kbInput.value;
        if (!text) return;
        kbInput.value = "";
        for (const ch of text) sendTypedCharacter(ch);
      });
    }
    function remotePoint(clientX, clientY) {
      const canvas = screen?.querySelector("canvas");
      if (!canvas || !rfb?._display) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = rfb._display.absX(clientX - rect.left);
      const y = rfb._display.absY(clientY - rect.top);
      return { x, y };
    }
    function sendMouse(clientX, clientY, buttonMask) {
      if (!rfb) return;
      const point = remotePoint(clientX, clientY);
      if (!point) return;
      try {
        if (typeof rfb._handleMouseButton === "function") {
          rfb._handleMouseButton(point.x, point.y, 1, buttonMask);
          rfb._handleMouseButton(point.x, point.y, 0, buttonMask);
          return;
        }
        if (typeof rfb._sendMouse === "function") {
          rfb._mouseButtonMask = buttonMask;
          rfb._sendMouse(point.x, point.y);
          rfb._mouseButtonMask = 0;
          rfb._sendMouse(point.x, point.y);
        }
      } catch {
      }
    }
    function coforgeAttachPhoneGestures() {
      if (!phone || !screen || gesturesBound) return;
      gesturesBound = true;
      let longPressTimer = 0;
      let longPressFired = false;
      let startX = 0;
      let startY = 0;
      let scrollY = 0;
      let pinchStart = 0;
      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };
      screen.addEventListener(
        "touchstart",
        (ev) => {
          if (!rfb) return;
          if (ev.touches.length === 1) {
            const touch = ev.touches[0];
            longPressFired = false;
            startX = touch.clientX;
            startY = touch.clientY;
            clearLongPress();
            longPressTimer = window.setTimeout(() => {
              longPressFired = true;
              sendMouse(touch.clientX, touch.clientY, 0x4);
            }, 450);
            return;
          }
          clearLongPress();
          if (ev.touches.length === 2) {
            ev.preventDefault();
            scrollY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
            const dx = ev.touches[0].clientX - ev.touches[1].clientX;
            const dy = ev.touches[0].clientY - ev.touches[1].clientY;
            pinchStart = Math.hypot(dx, dy);
          }
        },
        { passive: false },
      );
      screen.addEventListener(
        "touchmove",
        (ev) => {
          if (!rfb) return;
          if (ev.touches.length === 1 && longPressTimer) {
            const touch = ev.touches[0];
            if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > 12) clearLongPress();
            return;
          }
          if (ev.touches.length !== 2) return;
          ev.preventDefault();
          const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
          const dx = ev.touches[0].clientX - ev.touches[1].clientX;
          const dy = ev.touches[0].clientY - ev.touches[1].clientY;
          const distance = Math.hypot(dx, dy);
          const scrollDelta = midY - scrollY;
          if (Math.abs(scrollDelta) >= 24) {
            sendMouse(ev.touches[0].clientX, ev.touches[0].clientY, scrollDelta > 0 ? 0x10 : 0x8);
            scrollY = midY;
          }
          if (pinchStart > 0 && Math.abs(distance - pinchStart) >= 48) {
            applyPhoneMode(distance > pinchStart ? "pan" : "fit");
            pinchStart = distance;
          }
        },
        { passive: false },
      );
      screen.addEventListener(
        "touchend",
        (ev) => {
          clearLongPress();
          if (longPressFired) {
            ev.preventDefault();
            ev.stopPropagation();
            longPressFired = false;
          }
          if (ev.touches.length < 2) pinchStart = 0;
        },
        { passive: false },
      );
      screen.addEventListener(
        "touchcancel",
        () => {
          clearLongPress();
          pinchStart = 0;
        },
        { passive: true },
      );
    }

    let session = 0;
    let rfb;
    function connect() {
      const id = ++session;
      rfb = new RFB(screen, url);
      rfb.scaleViewport = true;
      rfb.focusOnClick = true;
      if (phone) {
        phoneBar?.classList.add("is-visible");
        applyPhoneMode(phoneMode);
        coforgeAttachPhoneGestures();
        coforgeAttachPhoneKeyboard();
        if (ctrlHeld) sendKey("ControlLeft", true);
      }
      rfb.addEventListener("connect", () => {
        showReconnect(false);
        if (msg) msg.hidden = true;
        if (phone) {
          applyPhoneMode(phoneMode);
          if (ctrlHeld) sendKey("ControlLeft", true);
        }
      });
      rfb.addEventListener("securityfailure", (ev) => {
        if (!msg) return;
        msg.hidden = false;
        msg.textContent = ev.detail?.reason || "桌面连接失败";
      });
      rfb.addEventListener("disconnect", () => {
        if (id !== session) return;
        showReconnect(true);
        if (!msg) return;
        msg.hidden = false;
        msg.textContent = "桌面连接已断开";
      });
    }
    reconnect?.addEventListener("click", () => {
      showReconnect(false);
      const previous = rfb;
      connect();
      try {
        previous?.disconnect();
      } catch {
      }
    });
    phoneBar?.addEventListener("click", (ev) => {
      const mode = ev.target?.closest?.("button[data-mode]")?.dataset?.mode;
      if (mode === "fit" || mode === "pan") {
        applyPhoneMode(mode);
        return;
      }
      const button = ev.target?.closest?.("button[data-key]");
      const code = button?.dataset?.key;
      if (!code || !rfb) return;
      if (code === "ControlLeft") {
        ctrlHeld = !ctrlHeld;
        button.classList.toggle("is-active", ctrlHeld);
        sendKey("ControlLeft", ctrlHeld);
        return;
      }
      sendKey(code, true);
      sendKey(code, false);
    });
    function coforgeDesktopPaste(text) {
      try {
        rfb._clipboardServerCapabilitiesFormats = {};
        rfb._clipboardServerCapabilitiesActions = {};
        rfb.clipboardPasteFrom(text);
      } catch {
      }
      const push = fetch(\`\${base}/clipboard\${query}\`, {
        method: "POST",
        body: text,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      }).catch(() => {});
      return push.then(() => {
        try {
          rfb.sendKey(0xffe3, "ControlLeft", true);
          rfb.sendKey(0x0076, "KeyV", true);
          rfb.sendKey(0x0076, "KeyV", false);
          rfb.sendKey(0xffe3, "ControlLeft", false);
        } catch {
        }
      });
    }
    document.addEventListener(
      "keydown",
      (ev) => {
        if (!rfb) return;
        if (!(ev.ctrlKey || ev.metaKey) || ev.code !== "KeyV" || ev.repeat) return;
        ev.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener(
      "keyup",
      (ev) => {
        if (!rfb) return;
        if (ev.code !== "KeyV" && ev.code !== "ControlLeft" && ev.code !== "ControlRight" && ev.code !== "MetaLeft" && ev.code !== "MetaRight") return;
        if (ev.code === "KeyV" || ev.ctrlKey || ev.metaKey) ev.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener("paste", (ev) => {
      if (!rfb) return;
      const text = ev.clipboardData?.getData("text/plain");
      if (!text) return;
      ev.preventDefault();
      void coforgeDesktopPaste(text);
    });
    connect();
`;

/** Present once office→cloud paste sets the clipboard then sends Ctrl+V. */
export const DESKTOP_PASTE_CLASSIC_MARKER = "coforgeDesktopPaste";

/** Present once the phone fit/pan toolbar is in the adapted page. */
export const DESKTOP_PHONE_VIEW_MARKER = "coforge-desktop-phone-bar";

/** Present once phone modifier keys and touch gestures are in the adapted page. */
export const DESKTOP_PHONE_GESTURES_MARKER = "coforgeAttachPhoneGestures";

/** Present once the hidden input that opens the system soft keyboard is in the page. */
export const DESKTOP_PHONE_KEYBOARD_MARKER = "coforge-desktop-keyboard-input";

const DESKTOP_CONTROLS = `<style>
#msg[hidden]{display:none!important}
#coforge-desktop-reconnect{position:fixed;top:50%;left:50%;z-index:2147483647;display:none;place-items:center;width:4.5rem;height:4.5rem;margin:0;padding:0;border:0;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
#coforge-desktop-reconnect.is-visible{display:grid}
#coforge-desktop-phone-bar{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;display:none;flex-wrap:wrap;justify-content:center;gap:8px;transform:translateX(-50%);padding:8px;border-radius:20px;background:rgba(0,0,0,.55);max-width:calc(100vw - 16px)}
#coforge-desktop-phone-bar.is-visible{display:flex}
#coforge-desktop-phone-bar button{min-height:44px;min-width:2.75rem;padding:0 12px;border:0;border-radius:999px;background:rgba(255,255,255,.9);color:#111;font:15px/1.2 sans-serif}
#coforge-desktop-phone-bar button.is-active{background:#fff;font-weight:600}
#coforge-desktop-keyboard-input{position:fixed;left:-100vw;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0}
</style><div id="coforge-desktop-phone-bar" role="toolbar" aria-label="手机桌面控制"><button type="button" data-mode="fit" class="is-active">适应屏幕</button><button type="button" data-mode="pan">实际大小</button><button type="button" data-action="keyboard">键盘</button><span id="coforge-desktop-keys" role="group" aria-label="手机桌面按键" style="display:contents"><button type="button" data-key="Escape">Esc</button><button type="button" data-key="ControlLeft">Ctrl</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="ArrowLeft">←</button><button type="button" data-key="ArrowUp">↑</button><button type="button" data-key="ArrowDown">↓</button><button type="button" data-key="ArrowRight">→</button></span></div><textarea id="coforge-desktop-keyboard-input" enterkeyhint="enter" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="手机输入"></textarea><button type="button" id="coforge-desktop-reconnect" aria-label="重新连接"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.68 17.5A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg></button>`;

function stripDesktopControls(html: string): string {
  return html
    .replace(/<style>\s*#msg\[hidden\][\s\S]*?<\/style>/g, "")
    .replace(/<div id="coforge-desktop-phone-bar"[\s\S]*?<\/div>/g, "")
    .replace(/<textarea id="coforge-desktop-keyboard-input"[\s\S]*?<\/textarea>/g, "")
    .replace(/<button type="button" id="coforge-desktop-reconnect"[\s\S]*?<\/button>/g, "");
}

function withDesktopControls(html: string): string {
  const cleaned = stripDesktopControls(html);
  if (cleaned.includes("</body>")) return cleaned.replace("</body>", `${DESKTOP_CONTROLS}</body>`);
  return `${cleaned}${DESKTOP_CONTROLS}`;
}

/** 80 is the Agent display-name cap. A crafted address cannot set a longer title. */
const DESKTOP_TITLE_MAX_LENGTH = 80;

/** The window title for one desktop page. Markup in the name stays text. */
export function withDesktopTitle(html: string, title: string | undefined): string {
  const text = title
    ? [...title]
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code >= 0x20 && code !== 0x7f;
        })
        .join("")
        .trim()
        .slice(0, DESKTOP_TITLE_MAX_LENGTH)
    : undefined;
  if (!text) return html;
  const safe = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (html.includes("<title>")) {
    return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${safe}</title>`);
  }
  return `<title>${safe}</title>${html}`;
}

/** Older images require a token in the address and load noVNC from the site root.
 * Current images already use a relative RFB import; both get reconnect, phone view,
 * keys, gestures and the soft keyboard. A page missing paste, phone view, gestures
 * or the keyboard input is rewritten so office→cloud paste and phone controls keep
 * working without waiting for a new image. */
export function adaptDesktopHtml(html: string): string {
  if (
    !html.includes('from "/core/rfb.js"') &&
    !html.includes('from "./core/rfb.js"') &&
    !html.includes("缺少连接令牌")
  )
    return html;
  if (
    html.includes('id="coforge-desktop-reconnect"') &&
    html.includes(DESKTOP_PASTE_CLASSIC_MARKER) &&
    html.includes(DESKTOP_PHONE_VIEW_MARKER) &&
    html.includes(DESKTOP_PHONE_GESTURES_MARKER) &&
    html.includes(DESKTOP_PHONE_KEYBOARD_MARKER)
  )
    return html;
  return withDesktopControls(
    html.replace(
      /<script type="module">[\s\S]*?<\/script>/,
      `<script type="module">${RELATIVE_PAGE_SCRIPT}  </script>`,
    ),
  );
}
