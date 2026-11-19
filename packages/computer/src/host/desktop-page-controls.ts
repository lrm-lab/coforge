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

/** Present once phone modifier keys and touch gestures are in the adapted page. */
export const DESKTOP_PHONE_GESTURES_MARKER = "coforgeAttachPhoneGestures";

/** Present once the hidden input that opens the system soft keyboard is in the page. */
export const DESKTOP_PHONE_KEYBOARD_MARKER = "coforge-desktop-keyboard-input";

const DESKTOP_CONTROLS = `<style>

#msg[hidden]{display:none!important}
#coforge-desktop-reconnect{position:fixed;top:50%;left:50%;z-index:2147483647;display:none;place-items:center;width:4.5rem;height:4.5rem;margin:0;padding:0;border:0;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.18);color:#fff;cursor:pointer}
#coforge-desktop-reconnect.is-visible{display:grid}
#coforge-desktop-phone-fab{position:fixed;right:max(14px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));z-index:2147483646;display:none;place-items:center;width:48px;height:48px;padding:0;border:0;border-radius:50%;background:rgba(40,40,40,.78);color:#fff;font:12px/1.1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);touch-action:none}
#coforge-desktop-phone-fab.is-visible{display:grid}
#coforge-desktop-phone-bar{position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;display:none;flex-wrap:wrap;justify-content:center;gap:8px;transform:translateX(-50%);padding:8px;border-radius:20px;background:rgba(0,0,0,.55);max-width:calc(100vw - 16px)}
#coforge-desktop-phone-bar.is-open{display:flex}
#coforge-desktop-phone-bar button{min-height:44px;min-width:2.75rem;padding:0 12px;border:0;border-radius:999px;background:rgba(255,255,255,.9);color:#111;font:15px/1.2 sans-serif}
#coforge-desktop-phone-bar button.is-active{background:#fff;font-weight:600}
#coforge-desktop-keyboard-input{position:fixed;left:-100vw;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0}
</style><button type="button" id="coforge-desktop-phone-fab" aria-label="手机桌面工具">工具</button><div id="coforge-desktop-phone-bar" role="toolbar" aria-label="手机桌面控制"><button type="button" data-mode="fit" class="is-active">适应屏幕</button><button type="button" data-mode="pan">实际大小</button><button type="button" data-action="keyboard">键盘</button><span id="coforge-desktop-keys" role="group" aria-label="手机桌面按键" style="display:contents"><button type="button" data-key="Escape">Esc</button><button type="button" data-key="ControlLeft">Ctrl</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="ArrowLeft">←</button><button type="button" data-key="ArrowUp">↑</button><button type="button" data-key="ArrowDown">↓</button><button type="button" data-key="ArrowRight">→</button></span><button type="button" data-shell="toggle-landscape">横竖屏</button><button type="button" data-shell="minimize">最小化</button><button type="button" data-shell="sleep">关闭</button></div><textarea id="coforge-desktop-keyboard-input" enterkeyhint="enter" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="手机输入"></textarea><button type="button" id="coforge-desktop-reconnect" aria-label="重新连接"><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.68 17.5A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg></button>`;

function stripDesktopControls(html: string): string {
  return html
    .replace(/<style>\s*#msg\[hidden\][\s\S]*?<\/style>/g, "")
    .replace(/<button type="button" id="coforge-desktop-phone-fab"[\s\S]*?<\/button>/g, "")
    .replace(/<div id="coforge-desktop-phone-bar"[\s\S]*?<\/div>/g, "")
    .replace(/<textarea id="coforge-desktop-keyboard-input"[\s\S]*?<\/textarea>/g, "")
    .replace(/<button type="button" id="coforge-desktop-reconnect"[\s\S]*?<\/button>/g, "");
}

export function withDesktopControls(html: string): string {
  const cleaned = stripDesktopControls(html);
  if (cleaned.includes("</body>")) return cleaned.replace("</body>", `${DESKTOP_CONTROLS}</body>`);
  return `${cleaned}${DESKTOP_CONTROLS}`;
}
