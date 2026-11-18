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
    let phoneMode = "fit";
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
      }
      rfb.addEventListener("connect", () => {
        showReconnect(false);
        if (msg) msg.hidden = true;
        if (phone) applyPhoneMode(phoneMode);
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
      if (mode === "fit" || mode === "pan") applyPhoneMode(mode);
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

const DESKTOP_CONTROLS = `<style>
#msg[hidden]{display:none!important}
#coforge-desktop-reconnect{position:fixed;top:50%;left:50%;z-index:2147483647;display:none;place-items:center;width:4.5rem;height:4.5rem;margin:0;padding:0;border:0;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
#coforge-desktop-reconnect.is-visible{display:grid}
#coforge-desktop-phone-bar{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;display:none;gap:8px;transform:translateX(-50%);padding:8px;border-radius:999px;background:rgba(0,0,0,.55)}
#coforge-desktop-phone-bar.is-visible{display:flex}
#coforge-desktop-phone-bar button{min-height:44px;min-width:5.5rem;padding:0 14px;border:0;border-radius:999px;background:rgba(255,255,255,.9);color:#111;font:15px/1.2 sans-serif}
#coforge-desktop-phone-bar button.is-active{background:#fff;font-weight:600}
</style><div id="coforge-desktop-phone-bar" role="toolbar" aria-label="手机桌面缩放"><button type="button" data-mode="fit" class="is-active">适应屏幕</button><button type="button" data-mode="pan">实际大小</button></div><button type="button" id="coforge-desktop-reconnect" aria-label="重新连接"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.68 17.5A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg></button>`;

function stripDesktopControls(html: string): string {
  return html
    .replace(/<style>\s*#msg\[hidden\][\s\S]*?<\/style>/g, "")
    .replace(/<div id="coforge-desktop-phone-bar"[\s\S]*?<\/div>/g, "")
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
 * Current images already use a relative RFB import; both get reconnect and phone view.
 * A page missing paste or phone view is rewritten so office→cloud paste and phone
 * fit/pan keep working without waiting for a new image. */
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
    html.includes(DESKTOP_PHONE_VIEW_MARKER)
  )
    return html;
  return withDesktopControls(
    html.replace(
      /<script type="module">[\s\S]*?<\/script>/,
      `<script type="module">${RELATIVE_PAGE_SCRIPT}  </script>`,
    ),
  );
}
