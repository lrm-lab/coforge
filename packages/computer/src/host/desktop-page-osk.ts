/** Phone browser-layer on-screen keyboard markup for desktop page adaptation. */

/** Present once the browser OSK panel is in the adapted page. */
export const DESKTOP_PHONE_OSK_MARKER = "coforge-desktop-osk";

/** Present once the OSK open/close helper is in the page script. */
export const DESKTOP_PHONE_OSK_SCRIPT_MARKER = "setPhoneOskOpen";

const attr = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const letter = (ch: string) => {
  const safe = attr(ch);
  const label = ch === " " ? "空格" : safe;
  return `<button type="button" data-osk-char="${safe}" aria-label="${label}">${ch === " " ? "空格" : ch}</button>`;
};

const row = (chars: string) => chars.split("").map(letter).join("");

export const DESKTOP_PHONE_OSK_STYLE = `#coforge-desktop-osk{position:fixed;left:0;right:0;bottom:0;z-index:2147483645;display:none;flex-direction:column;gap:6px;padding:8px 6px max(8px,env(safe-area-inset-bottom));background:rgba(28,28,30,.94);color:#f5f5f7;touch-action:manipulation;user-select:none;-webkit-user-select:none}
#coforge-desktop-osk.is-open{display:flex}
#coforge-desktop-osk.is-landscape{max-height:50vh;max-height:50dvh;overflow:auto;gap:3px;padding:4px 4px max(4px,env(safe-area-inset-bottom))}
#coforge-desktop-osk.is-landscape button{min-height:30px;font:600 13px/1.1 system-ui,sans-serif;border-radius:6px}
#coforge-desktop-osk .osk-row{display:flex;justify-content:center;gap:4px}
#coforge-desktop-osk.is-landscape .osk-row{gap:3px}
#coforge-desktop-osk button{flex:1 1 0;min-width:0;min-height:42px;padding:0 2px;border:0;border-radius:8px;background:rgba(255,255,255,.16);color:inherit;font:600 15px/1.1 system-ui,sans-serif}
#coforge-desktop-osk button.is-active{background:#5b8def}
#coforge-desktop-osk button.osk-wide{flex:1.4 1 0}
#coforge-desktop-osk button.osk-space{flex:4 1 0}
#coforge-desktop-osk button.osk-close{flex:0 0 42px;background:rgba(255,255,255,.08);display:grid;place-items:center}
#coforge-desktop-osk button.osk-close svg{display:block;width:22px;height:22px}
#coforge-desktop-osk.is-landscape button.osk-close{flex:0 0 34px}
#coforge-desktop-osk.is-landscape button.osk-close svg{width:18px;height:18px}
#coforge-desktop-osk[data-layer="sym"] .osk-letters{display:none}
#coforge-desktop-osk[data-layer="abc"] .osk-symbols{display:none}
#coforge-desktop-osk .osk-symbols{display:none}
#coforge-desktop-osk[data-layer="sym"] .osk-symbols{display:flex}`;

const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

export const DESKTOP_PHONE_OSK_MARKUP = `<div id="coforge-desktop-osk" data-layer="abc" role="group" aria-label="虚拟键盘" aria-hidden="true"><div class="osk-row"><button type="button" class="osk-close" data-osk-action="close" title="收起键盘" aria-label="收起键盘">${ICON_COLLAPSE}</button><button type="button" data-osk-mod="ControlLeft" aria-label="Ctrl">Ctrl</button><button type="button" data-osk-mod="AltLeft" aria-label="Alt">Alt</button><button type="button" data-osk-mod="MetaLeft" aria-label="Meta">Win</button><button type="button" data-osk-action="compose" aria-label="中文输入">中文</button><button type="button" data-osk-key="Escape" aria-label="Esc">Esc</button><button type="button" data-osk-key="Tab" aria-label="Tab">Tab</button></div><div class="osk-row osk-letters">${row("qwertyuiop")}</div><div class="osk-row osk-letters">${row("asdfghjkl")}</div><div class="osk-row osk-letters"><button type="button" class="osk-wide" data-osk-action="shift" aria-label="Shift">⇧</button>${row("zxcvbnm")}<button type="button" class="osk-wide" data-osk-keysym="0xff08" aria-label="退格">⌫</button></div><div class="osk-row osk-symbols">${row("1234567890")}</div><div class="osk-row osk-symbols">${row("-/:;()$&@")}</div><div class="osk-row osk-symbols"><button type="button" class="osk-wide" data-osk-action="layer-abc" aria-label="字母">ABC</button>${row(".,?!'" + '"#')}<button type="button" class="osk-wide" data-osk-keysym="0xff08" aria-label="退格">⌫</button></div><div class="osk-row"><button type="button" class="osk-wide" data-osk-action="layer-sym" aria-label="符号">123</button><button type="button" class="osk-space" data-osk-char=" " aria-label="空格">空格</button><button type="button" class="osk-wide" data-osk-keysym="0xff0d" aria-label="回车">↵</button></div></div>`;
