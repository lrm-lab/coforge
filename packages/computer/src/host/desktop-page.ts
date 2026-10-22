const RELATIVE_PAGE_SCRIPT = `
    import RFB from "./core/rfb.js";

    const msg = document.getElementById("msg");
    const screen = document.getElementById("screen");
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = location.pathname.replace(/\\/desktop\\.html$/, "").replace(/\\/+$/, "");
    const query = token ? \`?token=\${encodeURIComponent(token)}\` : "";
    const url = \`\${proto}://\${location.host}\${base}/websockify\${query}\`;
    const reconnect = document.getElementById("coforge-desktop-reconnect");
    const showReconnect = (visible) => {
      reconnect?.classList.toggle("is-visible", visible);
    };

    let session = 0;
    let rfb;
    function connect() {
      const id = ++session;
      rfb = new RFB(screen, url);
      rfb.scaleViewport = true;
      rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => {
        showReconnect(false);
        if (msg) msg.hidden = true;
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
        /* the new session already replaced it */
      }
    });
    connect();
`;

const RECONNECT_CONTROL = `<style>
#msg[hidden]{display:none!important}
#coforge-desktop-reconnect{position:fixed;top:50%;left:50%;z-index:2147483647;display:none;place-items:center;width:4.5rem;height:4.5rem;margin:0;padding:0;border:0;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
#coforge-desktop-reconnect.is-visible{display:grid}
</style><button type="button" id="coforge-desktop-reconnect" aria-label="重新连接"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.68 17.5A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg></button>`;

function withReconnectControl(html: string): string {
  if (html.includes("</body>")) return html.replace("</body>", `${RECONNECT_CONTROL}</body>`);
  return `${html}${RECONNECT_CONTROL}`;
}

/** 80 is the Agent display-name cap. A crafted address cannot set a longer title. */
const DESKTOP_TITLE_MAX_LENGTH = 80;

/** The window title for one desktop page. Markup in the name stays text. */
export function withDesktopTitle(html: string, title: string | undefined): string {
  const text = title
    ?.replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, DESKTOP_TITLE_MAX_LENGTH);
  if (!text) return html;
  const safe = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (html.includes("<title>")) {
    return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${safe}</title>`);
  }
  return `<title>${safe}</title>${html}`;
}

/** Older images require a token in the address and load noVNC from the site root.
 * Current images already use a relative RFB import; both get the reconnect control. */
export function adaptDesktopHtml(html: string): string {
  if (
    !html.includes('from "/core/rfb.js"') &&
    !html.includes('from "./core/rfb.js"') &&
    !html.includes("缺少连接令牌")
  )
    return html;
  if (html.includes('id="coforge-desktop-reconnect"')) return html;
  return withReconnectControl(
    html.replace(
      /<script type="module">[\s\S]*?<\/script>/,
      `<script type="module">${RELATIVE_PAGE_SCRIPT}  </script>`,
    ),
  );
}
