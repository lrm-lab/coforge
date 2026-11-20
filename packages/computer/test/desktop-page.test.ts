import { describe, expect, test } from "bun:test";

import { adaptDesktopHtml, withDesktopTitle } from "#src/host/desktop-proxy";

const oldPage = `<!DOCTYPE html>
<script type="module">
    import RFB from "/core/rfb.js";
    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      document.body.textContent = "缺少连接令牌";
    }
</script>
`;

describe("desktop page adaptation", () => {
  test("an older desktop page no longer demands a token in the address", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('from "./core/rfb.js"');
    expect(html).not.toContain("缺少连接令牌");
    expect(html).toContain("/websockify");
  });

  test("a dropped desktop session offers a centered control that connects again", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('id="coforge-desktop-reconnect"');
    expect(html).toContain("重新连接");
    expect(html).not.toContain("msg.remove()");
    expect(html).toContain('addEventListener("click"');
    expect(html).toContain("new RFB");
  });

  test("a connected desktop hides the connecting overlay even when the page sets display:flex", () => {
    const page = `<!DOCTYPE html>
<style>#msg { display: flex; }</style>
<p id="msg">正在连接桌面…</p>
<script type="module">
    import RFB from "./core/rfb.js";
</script>
`;
    const html = adaptDesktopHtml(page);
    expect(html).toContain("#msg[hidden]{display:none!important}");
    expect(html).toContain("msg.hidden = true");
    expect(html).toContain("正在连接桌面…");
  });

  test("a page that already loads RFB relatively still gets the reconnect control", () => {
    const currentPage = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    const rfb = new RFB(document.getElementById("screen"), "ws://example/websockify");
    rfb.addEventListener("connect", () => msg.remove());
</script>
`;
    const html = adaptDesktopHtml(currentPage);
    expect(html).toContain('id="coforge-desktop-reconnect"');
    expect(html).toContain('id="coforge-desktop-phone-bar"');
    expect(html).not.toContain("msg.remove()");
  });

  test("a reconnect page that already has phone gestures, keyboard, clipboard push, fab viewport and copy-out is left alone", () => {
    const current = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgePushRemoteClipboard(text) {}
    function coforgeWriteLocalClipboard(text) {}
    function coforgeDesktopCopyOut() {}
    function applyPhoneViewportScale() {}
    function placePhoneFabInViewport() {}
    const phone = params.get("view") === "phone";
</script>
<button type="button" id="coforge-desktop-phone-fab"></button>
<div id="coforge-desktop-phone-bar"><div id="coforge-desktop-key-pad"></div></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    expect(adaptDesktopHtml(current)).toBe(current);
  });

  test("a page with the old text tray is rewritten for the compact icon pad", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgeWriteLocalClipboard(text) {}
    function coforgeDesktopCopyOut() {}
    function applyPhoneViewportScale() {}
    function placePhoneFabInViewport() {}
    const phone = params.get("view") === "phone";
</script>
<button type="button" id="coforge-desktop-phone-fab"></button>
<div id="coforge-desktop-phone-bar"><button type="button" data-mode="pan">实际大小</button></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforge-desktop-key-pad");
    expect(html).toContain('aria-label="适应屏幕"');
    expect(html).not.toContain("实际大小");
    expect(html).not.toContain('data-key="ControlLeft"');
    expect(html).not.toBe(stale);
  });

  test("a page with the old two-level pinch gestures is rewritten for continuous zoom", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgeWriteLocalClipboard(text) {}
    function coforgeDesktopCopyOut() {}
    function coforgeAttachPhoneGestures() {}
    function placePhoneFabInViewport() {}
    const phone = params.get("view") === "phone";
</script>
<button type="button" id="coforge-desktop-phone-fab"></button>
<div id="coforge-desktop-phone-bar"></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("applyPhoneViewportScale");
    expect(html).toContain("viewportChangePos");
    expect(html).not.toBe(stale);
  });

  test("a FAB page without viewport reclamp is rewritten", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgeWriteLocalClipboard(text) {}
    function coforgeDesktopCopyOut() {}
    function coforgeAttachPhoneGestures() {}
    function coforgeAttachPhoneFab() {}
    const phone = params.get("view") === "phone";
</script>
<button type="button" id="coforge-desktop-phone-fab"></button>
<div id="coforge-desktop-phone-bar"></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("placePhoneFabInViewport");
    expect(html).not.toBe(stale);
  });

  test("a phone fit/pan page without gestures is rewritten for keys and touch", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
</script>
<div id="coforge-desktop-phone-bar"></div>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforgeAttachPhoneGestures");
    expect(html).toContain('id="coforge-desktop-key-pad"');
  });

  test("a focused paste sends the local plain text into the remote clipboard", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('addEventListener("paste"');
    expect(html).toContain('getData("text/plain")');
    expect(html).toContain("coforgeDesktopPaste");
    expect(html).toContain("coforgeDesktopCopyOut");
    expect(html).toContain("coforgeWriteLocalClipboard");
    expect(html).toContain("coforgeExecCommandCopy");
    expect(html).not.toContain("clipboardPasteFrom(text)");
    expect(html).toContain("/clipboard");
    expect(html).toContain("sendKey(0xffe3");
    expect(html).toContain("navigator.clipboard?.writeText");
    expect(html).toContain('addEventListener("clipboard"');
    expect(html).toContain('"copy"');
    expect(html).toContain('"cut"');
    expect(html).toContain("stopImmediatePropagation");
    expect(html).toContain("preventDefault()");
  });

  test("a phone viewer can fit the shared desktop or pan at native size", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('params.get("view") === "phone"');
    expect(html).toContain("applyPhoneViewportScale");
    expect(html).toContain("clipViewport");
    expect(html).toContain("dragViewport = false");
    expect(html).toContain('id="coforge-desktop-phone-bar"');
    expect(html).toContain('id="coforge-desktop-phone-fab"');
    expect(html).toContain("coforgeAttachPhoneFab");
    expect(html).toContain('data-shell="minimize"');
    expect(html).toContain('data-shell="sleep"');
    expect(html).toContain('aria-label="适应屏幕"');
    expect(html).toContain('data-mode="fit"');
    expect(html).not.toContain("实际大小");
  });

  test("a page with the old always-visible phone bar is rewritten for the FAB", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgeWriteLocalClipboard(text) {}
    function coforgeDesktopCopyOut() {}
    function coforgeAttachPhoneGestures() {}
    const phone = params.get("view") === "phone";
</script>
<div id="coforge-desktop-phone-bar"></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain('id="coforge-desktop-phone-fab"');
    expect(html).toContain("coforgeAttachPhoneFab");
  });

  test("a phone viewer gets continuous pinch zoom, one-finger pan, and wheel when fitted", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('id="coforge-desktop-key-pad"');
    expect(html).toContain('id="coforge-desktop-arrows"');
    expect(html).toContain('data-key="Escape"');
    expect(html).toContain('data-key="Tab"');
    expect(html).toContain('data-key="ArrowUp"');
    expect(html).toContain('data-key="ArrowDown"');
    expect(html).not.toContain('data-key="ControlLeft"');
    expect(html).toContain("coforgeAttachPhoneGestures");
    expect(html).toContain("applyPhoneViewportScale");
    expect(html).toContain("viewportChangeSize");
    expect(html).toContain("clipViewport = true");
    expect(html).toContain("schedulePhoneViewportApply");
    expect(html).toContain("ResizeObserver");
    expect(html).toContain("viewportChangePos");
    expect(html).toContain("capture: true");
    expect(html).toContain("touchstart");
    expect(html).toContain("buttonMask");
    expect(html).toContain("travel <= 20");
    expect(html).not.toContain("absX(clientX");
    expect(html).toContain("0xff1b");
  });

  test("a phone viewer can open the system soft keyboard", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('id="coforge-desktop-keyboard-input"');
    expect(html).toContain('data-action="keyboard"');
    expect(html).toContain('aria-label="键盘"');
    expect(html).toContain("coforgeAttachPhoneKeyboard");
    expect(html).toContain("0x01000000");
    expect(html).toContain("0xff08");
    expect(html).toContain("placePhoneFabInViewport");
    expect(html).toMatch(/openKeyboard\(\);\s*setPhoneTrayOpen\(false\)/);
  });

  test("a phone long-press warms the cloud clipboard before the right-click menu", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).not.toContain('data-action="paste"');
    expect(html).toContain("coforgePushRemoteClipboard");
    expect(html).toContain("navigator.clipboard?.readText");
    expect(html).toContain("phoneClipboardRead");
    expect(html).toContain("sendMouse(x, y, 0x4)");
  });

  test("a reconnect page that still uses extended clipboard paste is rewritten", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    const rfb = new RFB(document.getElementById("screen"), "ws://example/websockify");
    document.addEventListener("paste", (ev) => {
      rfb.clipboardPasteFrom(ev.clipboardData.getData("text/plain"));
    });
</script>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforgeDesktopPaste");
    expect(html).toContain("coforgeDesktopCopyOut");
    expect(html).toContain("coforgeWriteLocalClipboard");
    expect(html).toContain("sendKey(0xffe3");
  });

  test("a page with paste but no copy-out is rewritten for cloud-to-office copy", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
</script>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforgeDesktopCopyOut");
    expect(html).toContain("coforgeWriteLocalClipboard");
    expect(html).toContain("navigator.clipboard?.writeText");
  });

  test("a page with the old copy-out marker is rewritten for local clipboard write", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    function coforgeDesktopCopyOut() {}
    function coforgeAttachPhoneGestures() {}
    const phone = params.get("view") === "phone";
</script>
<div id="coforge-desktop-phone-bar"></div>
<textarea id="coforge-desktop-keyboard-input"></textarea>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforgeWriteLocalClipboard");
    expect(html).toContain('"copy"');
  });

  test("the page title becomes the requested name, and markup in it stays text", () => {
    const page = "<title>云电脑桌面</title><script>ok</script>";
    expect(withDesktopTitle(page, "小明")).toBe("<title>小明</title><script>ok</script>");
    expect(withDesktopTitle(page, "A&B<C>")).toBe(
      "<title>A&amp;B&lt;C&gt;</title><script>ok</script>",
    );
    expect(withDesktopTitle(page, undefined)).toBe(page);
    expect(withDesktopTitle(page, " \n ")).toBe(page);
    expect(withDesktopTitle(page, `${"名".repeat(81)}`)).toBe(
      `<title>${"名".repeat(80)}</title><script>ok</script>`,
    );
  });
});
