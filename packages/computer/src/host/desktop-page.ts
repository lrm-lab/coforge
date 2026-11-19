import { RELATIVE_PAGE_SCRIPT } from "./desktop-page-script";
import {
  DESKTOP_CLIPBOARD_OUT_MARKER,
  DESKTOP_PASTE_CLASSIC_MARKER,
  DESKTOP_PHONE_FAB_MARKER,
  DESKTOP_PHONE_GESTURES_MARKER,
  DESKTOP_PHONE_KEYBOARD_MARKER,
  DESKTOP_PHONE_VIEW_MARKER,
  withDesktopControls,
} from "./desktop-page-controls";

export {
  DESKTOP_CLIPBOARD_OUT_MARKER,
  DESKTOP_PASTE_CLASSIC_MARKER,
  DESKTOP_PHONE_FAB_MARKER,
  DESKTOP_PHONE_GESTURES_MARKER,
  DESKTOP_PHONE_KEYBOARD_MARKER,
  DESKTOP_PHONE_VIEW_MARKER,
} from "./desktop-page-controls";

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
 * keys, gestures, soft keyboard and UTF-8 clipboard copy-out. A page missing paste,
 * copy-out, phone view, gestures or the keyboard input is rewritten. */
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
    html.includes(DESKTOP_CLIPBOARD_OUT_MARKER) &&
    html.includes(DESKTOP_PHONE_VIEW_MARKER) &&
    html.includes(DESKTOP_PHONE_FAB_MARKER) &&
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
