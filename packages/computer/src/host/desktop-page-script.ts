/** Injected noVNC page script for desktop proxy adaptation. */

import { DESKTOP_PAGE_CLIPBOARD_SCRIPT } from "./desktop-page-script-clipboard";

export const RELATIVE_PAGE_SCRIPT = `
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
    const phoneFab = document.getElementById("coforge-desktop-phone-fab");
    const showReconnect = (visible) => {
      reconnect?.classList.toggle("is-visible", visible);
    };
    let phoneTrayOpen = false;
    function placePhoneFabInViewport() {
      if (!phoneFab) return;
      const fabWidth = phoneFab.offsetWidth || 48;
      const fabHeight = phoneFab.offsetHeight || 48;
      const maxLeft = Math.max(0, window.innerWidth - fabWidth);
      const maxTop = Math.max(0, window.innerHeight - fabHeight);
      let left;
      let top;
      if (phoneFab.style.left || phoneFab.style.top) {
        left = Number.parseFloat(phoneFab.style.left || "0");
        top = Number.parseFloat(phoneFab.style.top || "0");
        if (!Number.isFinite(left)) left = 0;
        if (!Number.isFinite(top)) top = 0;
      } else {
        left = maxLeft - 14;
        top = maxTop - 18;
      }
      left = Math.min(maxLeft, Math.max(0, left));
      top = Math.min(maxTop, Math.max(0, top));
      phoneFab.style.left = \`\${left}px\`;
      phoneFab.style.top = \`\${top}px\`;
      phoneFab.style.right = "auto";
      phoneFab.style.bottom = "auto";
    }
    function setPhoneTrayOpen(open) {
      if (!phone) return;
      phoneTrayOpen = open;
      phoneBar?.classList.toggle("is-open", open);
      phoneFab?.classList.toggle("is-visible", !open);
      if (!open) placePhoneFabInViewport();
    }
    function notifyDesktopShell(action) {
      try {
        parent.postMessage({ coforgeDesktop: true, action }, "*");
      } catch {
      }
    }
    function coforgeAttachPhoneFab() {
      if (!phone || !phoneFab || phoneFab.dataset.bound === "1") return;
      phoneFab.dataset.bound = "1";
      let drag = null;
      const onMove = (ev) => {
        if (!drag) return;
        const fabWidth = phoneFab.offsetWidth || 48;
        const fabHeight = phoneFab.offsetHeight || 48;
        const maxLeft = Math.max(0, window.innerWidth - fabWidth);
        const maxTop = Math.max(0, window.innerHeight - fabHeight);
        const left = Math.min(maxLeft, Math.max(0, ev.clientX - drag.ox));
        const top = Math.min(maxTop, Math.max(0, ev.clientY - drag.oy));
        phoneFab.style.left = \`\${left}px\`;
        phoneFab.style.top = \`\${top}px\`;
        phoneFab.style.right = "auto";
        phoneFab.style.bottom = "auto";
        if (Math.hypot(left - drag.startLeft, top - drag.startTop) > 8) drag.moved = true;
      };
      const onUp = () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!moved) setPhoneTrayOpen(true);
        else placePhoneFabInViewport();
      };
      phoneFab.addEventListener("pointerdown", (ev) => {
        if (phoneTrayOpen) return;
        const rect = phoneFab.getBoundingClientRect();
        drag = {
          ox: ev.clientX - rect.left,
          oy: ev.clientY - rect.top,
          startLeft: rect.left,
          startTop: rect.top,
          moved: false,
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      document.addEventListener(
        "pointerdown",
        (ev) => {
          if (!phoneTrayOpen) return;
          const target = ev.target;
          if (phoneBar?.contains(target) || phoneFab.contains(target)) return;
          setPhoneTrayOpen(false);
        },
        true,
      );
      window.addEventListener("resize", () => {
        if (!phoneTrayOpen) placePhoneFabInViewport();
      });
      placePhoneFabInViewport();
    }
    const KEYSYMS = {
      Escape: 0xff1b,
      Tab: 0xff09,
      ControlLeft: 0xffe3,
      ArrowLeft: 0xff51,
      ArrowUp: 0xff52,
      ArrowRight: 0xff53,
      ArrowDown: 0xff54,
    };
    let phoneScale = 0;
    let ctrlHeld = false;
    let gesturesBound = false;
    function phoneFrameSize() {
      const display = rfb?._display;
      const width = display?.width || 0;
      const height = display?.height || 0;
      return { width, height };
    }
    function phoneFitScale() {
      const { width, height } = phoneFrameSize();
      const cw = screen?.clientWidth || 0;
      const ch = screen?.clientHeight || 0;
      if (cw <= 0 || ch <= 0 || width <= 0 || height <= 0) return 1;
      return Math.min(cw / width, ch / height, 1);
    }
    function phoneViewportCanPan() {
      return phoneScale > phoneFitScale() + 0.02;
    }
    function syncPhoneModeButtons() {
      const fit = phoneFitScale();
      const nearFit = phoneScale <= fit + 0.03;
      const nearNative = phoneScale >= 0.97;
      phoneBar?.querySelectorAll("button[data-mode]").forEach((button) => {
        const mode = button.dataset.mode;
        button.classList.toggle(
          "is-active",
          (mode === "fit" && nearFit) || (mode === "pan" && nearNative && !nearFit),
        );
      });
    }
    function applyPhoneViewportScale(scale) {
      if (!rfb || !phone || !rfb._display) return;
      const fit = phoneFitScale();
      const next = Math.min(1, Math.max(fit, Number.isFinite(scale) ? scale : fit));
      phoneScale = next;
      rfb.scaleViewport = false;
      rfb.dragViewport = false;
      rfb.clipViewport = phoneViewportCanPan();
      try {
        rfb._display.scale = next;
      } catch {
      }
      syncPhoneModeButtons();
    }
    function applyPhoneMode(mode) {
      if (!rfb || !phone) return;
      applyPhoneViewportScale(mode === "pan" ? 1 : phoneFitScale());
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
        setPhoneTrayOpen(false);
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
      let oneFinger = null;
      let pinch = null;
      const touchOpts = { passive: false, capture: true };
      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };
      const panViewport = (dx, dy) => {
        const display = rfb?._display;
        if (!display || typeof display.viewportChangePos !== "function") return;
        try {
          display.viewportChangePos(-dx / Math.max(phoneScale, 0.01), -dy / Math.max(phoneScale, 0.01));
        } catch {
        }
      };
      screen.addEventListener(
        "touchstart",
        (ev) => {
          if (!rfb) return;
          if (ev.touches.length >= 2) {
            clearLongPress();
            oneFinger = null;
            ev.preventDefault();
            ev.stopPropagation();
            const dx = ev.touches[0].clientX - ev.touches[1].clientX;
            const dy = ev.touches[0].clientY - ev.touches[1].clientY;
            pinch = {
              startDistance: Math.hypot(dx, dy),
              startScale: phoneScale || phoneFitScale(),
            };
            return;
          }
          if (ev.touches.length !== 1) return;
          pinch = null;
          const touch = ev.touches[0];
          longPressFired = false;
          oneFinger = {
            startX: touch.clientX,
            startY: touch.clientY,
            lastX: touch.clientX,
            lastY: touch.clientY,
            moved: false,
            panning: false,
            scrolling: false,
          };
          clearLongPress();
          longPressTimer = window.setTimeout(() => {
            if (!oneFinger || oneFinger.moved) return;
            longPressFired = true;
            sendMouse(oneFinger.startX, oneFinger.startY, 0x4);
          }, 450);
        },
        touchOpts,
      );
      screen.addEventListener(
        "touchmove",
        (ev) => {
          if (!rfb) return;
          if (ev.touches.length >= 2 && pinch) {
            ev.preventDefault();
            ev.stopPropagation();
            const dx = ev.touches[0].clientX - ev.touches[1].clientX;
            const dy = ev.touches[0].clientY - ev.touches[1].clientY;
            const distance = Math.hypot(dx, dy);
            if (!(pinch.startDistance > 0) || !(distance > 0)) return;
            applyPhoneViewportScale(pinch.startScale * (distance / pinch.startDistance));
            return;
          }
          if (ev.touches.length !== 1 || !oneFinger) return;
          const touch = ev.touches[0];
          const totalDx = touch.clientX - oneFinger.startX;
          const totalDy = touch.clientY - oneFinger.startY;
          const stepDx = touch.clientX - oneFinger.lastX;
          const stepDy = touch.clientY - oneFinger.lastY;
          oneFinger.lastX = touch.clientX;
          oneFinger.lastY = touch.clientY;
          if (!oneFinger.moved && Math.hypot(totalDx, totalDy) > 12) {
            oneFinger.moved = true;
            clearLongPress();
            if (phoneViewportCanPan()) oneFinger.panning = true;
            else if (Math.abs(totalDy) >= Math.abs(totalDx)) oneFinger.scrolling = true;
          }
          if (oneFinger.panning) {
            ev.preventDefault();
            ev.stopPropagation();
            panViewport(stepDx, stepDy);
            return;
          }
          if (oneFinger.scrolling && Math.abs(stepDy) >= 8) {
            ev.preventDefault();
            ev.stopPropagation();
            sendMouse(touch.clientX, touch.clientY, stepDy > 0 ? 0x10 : 0x8);
          }
        },
        touchOpts,
      );
      screen.addEventListener(
        "touchend",
        (ev) => {
          if (ev.touches.length < 2) pinch = null;
          if (ev.touches.length > 0) return;
          clearLongPress();
          const gesture = oneFinger;
          oneFinger = null;
          if (!gesture) return;
          if (longPressFired) {
            ev.preventDefault();
            ev.stopPropagation();
            longPressFired = false;
            return;
          }
          if (!gesture.moved && !gesture.panning && !gesture.scrolling) {
            ev.preventDefault();
            ev.stopPropagation();
            sendMouse(gesture.startX, gesture.startY, 0x1);
          }
        },
        touchOpts,
      );
      screen.addEventListener(
        "touchcancel",
        () => {
          clearLongPress();
          oneFinger = null;
          pinch = null;
        },
        touchOpts,
      );
      window.addEventListener("resize", () => {
        if (!phone || !rfb) return;
        applyPhoneViewportScale(phoneScale || phoneFitScale());
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
        applyPhoneMode("fit");
        coforgeAttachPhoneGestures();
        coforgeAttachPhoneKeyboard();
        coforgeAttachPhoneFab();
        setPhoneTrayOpen(false);
        if (ctrlHeld) sendKey("ControlLeft", true);
      }
      rfb.addEventListener("connect", () => {
        showReconnect(false);
        if (msg) msg.hidden = true;
        if (phone) {
          applyPhoneViewportScale(phoneScale || phoneFitScale());
          if (ctrlHeld) sendKey("ControlLeft", true);
        }
      });
      rfb.addEventListener("desktopresize", () => {
        if (phone) applyPhoneViewportScale(phoneScale || phoneFitScale());
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
      rfb.addEventListener("clipboard", () => {
        void coforgeDesktopCopyOut();
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
      const shell = ev.target?.closest?.("button[data-shell]")?.dataset?.shell;
      if (shell === "minimize" || shell === "sleep" || shell === "toggle-landscape") {
        notifyDesktopShell(shell);
        return;
      }
      const mode = ev.target?.closest?.("button[data-mode]")?.dataset?.mode;
      if (mode === "fit" || mode === "pan") {
        applyPhoneMode(mode);
        return;
      }
      if (ev.target?.closest?.('button[data-action="keyboard"]')) return;
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
${DESKTOP_PAGE_CLIPBOARD_SCRIPT}
    connect();
  `;
