/** Present once office→cloud paste sets the UTF-8 clipboard then sends Ctrl+V. */
export const DESKTOP_PASTE_CLASSIC_MARKER = "coforgeDesktopPaste";

/** Present once cloud→office copy writes UTF-8 CLIPBOARD into the local clipboard. */
export const DESKTOP_CLIPBOARD_OUT_MARKER = "coforgeWriteLocalClipboard";

/** Present once the phone fit/pan toolbar is in the adapted page. */
export const DESKTOP_PHONE_VIEW_MARKER = "coforge-desktop-phone-bar";

/** Present once the phone toolbar collapses to a draggable FAB. */
export const DESKTOP_PHONE_FAB_MARKER = "coforge-desktop-phone-fab";

/** Present once the FAB reclamps into the iframe viewport (fake landscape resize). */
export const DESKTOP_PHONE_FAB_VIEWPORT_MARKER = "placePhoneFabInViewport";

/** Present once phone modifier keys and continuous viewport gestures are in the adapted page. */
export const DESKTOP_PHONE_GESTURES_MARKER = "applyPhoneViewportScale";

/** Present once the compact icon tray (fit/landscape/keyboard + Esc/Tab + inverted-T arrows) is in the page. */
export const DESKTOP_PHONE_TRAY_LAYOUT_MARKER = "coforge-desktop-key-pad";

/** Present once the hidden input that opens the system soft keyboard is in the page. */
export const DESKTOP_PHONE_KEYBOARD_MARKER = "coforge-desktop-keyboard-input";

/** Present once a long-press right-click warms the cloud clipboard from the phone. */
export const DESKTOP_PHONE_PASTE_MARKER = "coforgePushRemoteClipboard";

const ICON_FIT = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4"/><path d="M15 3h4a2 2 0 0 1 2 2v4"/><path d="M9 21H5a2 2 0 0 1-2-2v-4"/><path d="M15 21h4a2 2 0 0 0 2-2v-4"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>`;
const ICON_LANDSCAPE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="10" height="7" rx="1.2"/><rect x="12" y="4" width="7" height="10" rx="1.2"/><path d="M19.5 16.5a6 6 0 0 1-8 2"/><path d="M12 20.5h2.5v-2.5"/></svg>`;
const ICON_KEYBOARD = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>`;
const ICON_MINIMIZE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

const DESKTOP_CONTROLS = `<style>
#msg[hidden]{display:none!important}
#coforge-desktop-reconnect{position:fixed;top:50%;left:50%;z-index:2147483647;display:none;place-items:center;width:4.5rem;height:4.5rem;margin:0;padding:0;border:0;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
#coforge-desktop-reconnect.is-visible{display:grid}
#coforge-desktop-phone-fab{position:fixed;right:max(14px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));z-index:2147483646;display:none;place-items:center;width:48px;height:48px;padding:0;border:0;border-radius:50%;background:rgba(40,40,40,.78);color:#fff;font:12px/1.1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);touch-action:none}
#coforge-desktop-phone-fab.is-visible{display:grid}
#coforge-desktop-phone-bar{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;display:none;flex-direction:column;gap:10px;transform:translateX(-50%);padding:12px;border-radius:20px;background:rgba(0,0,0,.55);max-width:calc(100vw - 16px);width:min(320px,calc(100vw - 16px))}
#coforge-desktop-phone-bar.is-open{display:flex}
#coforge-desktop-phone-bar .coforge-desktop-tray-row{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
#coforge-desktop-phone-bar button{min-height:42px;min-width:42px;padding:0 12px;border:0;border-radius:999px;background:rgba(255,255,255,.9);color:#111;font:500 13px/1.1 sans-serif}
#coforge-desktop-phone-bar button.is-active{background:#fff;font-weight:600}
#coforge-desktop-phone-bar button.coforge-desktop-icon{width:44px;min-width:44px;height:44px;min-height:44px;padding:0;display:grid;place-items:center}
#coforge-desktop-phone-bar button.coforge-desktop-icon svg{display:block}
#coforge-desktop-phone-bar button.coforge-desktop-danger{color:#7a1f1f}
#coforge-desktop-key-pad{display:grid;grid-template-columns:auto auto;gap:28px;align-items:center;justify-content:center;margin:0 auto}
#coforge-desktop-side-keys{display:flex;flex-direction:column;gap:10px}
#coforge-desktop-arrows{display:grid;grid-template-columns:42px 42px 42px;grid-template-rows:38px 38px;gap:2px}
#coforge-desktop-arrows button,#coforge-desktop-side-keys button{min-width:42px;min-height:38px;padding:0}
#coforge-desktop-arrows .up{grid-column:2;grid-row:1}
#coforge-desktop-arrows .left{grid-column:1;grid-row:2}
#coforge-desktop-arrows .down{grid-column:2;grid-row:2}
#coforge-desktop-arrows .right{grid-column:3;grid-row:2}
#coforge-desktop-keyboard-input{position:fixed;left:-100vw;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0}
</style><button type="button" id="coforge-desktop-phone-fab" aria-label="手机桌面工具">工具</button><div id="coforge-desktop-phone-bar" role="toolbar" aria-label="手机桌面控制"><div class="coforge-desktop-tray-row"><button type="button" data-mode="fit" class="coforge-desktop-icon is-active" aria-label="适应屏幕" title="适应屏幕">${ICON_FIT}</button><button type="button" data-shell="toggle-landscape" class="coforge-desktop-icon" aria-label="横竖屏" title="横竖屏">${ICON_LANDSCAPE}</button><button type="button" data-action="keyboard" class="coforge-desktop-icon" aria-label="键盘" title="键盘">${ICON_KEYBOARD}</button></div><div id="coforge-desktop-key-pad"><div id="coforge-desktop-side-keys"><button type="button" data-key="Escape">Esc</button><button type="button" data-key="Tab">Tab</button></div><div id="coforge-desktop-arrows" role="group" aria-label="方向键"><button type="button" class="up" data-key="ArrowUp">↑</button><button type="button" class="left" data-key="ArrowLeft">←</button><button type="button" class="down" data-key="ArrowDown">↓</button><button type="button" class="right" data-key="ArrowRight">→</button></div></div><div class="coforge-desktop-tray-row"><button type="button" data-shell="minimize" class="coforge-desktop-icon" aria-label="最小化" title="最小化">${ICON_MINIMIZE}</button><button type="button" data-shell="sleep" class="coforge-desktop-icon coforge-desktop-danger" aria-label="关闭" title="关闭">${ICON_CLOSE}</button></div></div><textarea id="coforge-desktop-keyboard-input" enterkeyhint="enter" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="手机输入"></textarea><button type="button" id="coforge-desktop-reconnect" aria-label="重新连接"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.68 17.5A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg></button>`;

function stripDesktopControls(html: string): string {
  return html
    .replace(/<style>\s*#msg\[hidden\][\s\S]*?<\/style>/g, "")
    .replace(/<button type="button" id="coforge-desktop-phone-fab"[\s\S]*?<\/button>/g, "")
    .replace(
      /<div id="coforge-desktop-phone-bar"[\s\S]*?(?=<textarea id="coforge-desktop-keyboard-input"|<button type="button" id="coforge-desktop-reconnect"|$)/g,
      "",
    )
    .replace(/<textarea id="coforge-desktop-keyboard-input"[\s\S]*?<\/textarea>/g, "")
    .replace(/<button type="button" id="coforge-desktop-reconnect"[\s\S]*?<\/button>/g, "");
}

export function withDesktopControls(html: string): string {
  const cleaned = stripDesktopControls(html);
  if (cleaned.includes("</body>")) return cleaned.replace("</body>", `${DESKTOP_CONTROLS}</body>`);
  return `${cleaned}${DESKTOP_CONTROLS}`;
}
