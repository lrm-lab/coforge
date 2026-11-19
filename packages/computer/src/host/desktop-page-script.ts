/** Injected noVNC page script for desktop proxy adaptation. */

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
        applyPhoneMode(phoneMode);
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
    function coforgeDesktopPaste(text) {
      const push = fetch(\`\${base}/clipboard\${query}\`, {
        method: "POST",
        body: text,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      });
      return push.then((res) => {
        if (!res.ok) return;
        try {
          rfb.sendKey(0xffe3, "ControlLeft", true);
          rfb.sendKey(0x0076, "KeyV", true);
          rfb.sendKey(0x0076, "KeyV", false);
          rfb.sendKey(0xffe3, "ControlLeft", false);
        } catch {
        }
      }).catch(() => {});
    }
    function coforgeWriteLocalClipboard(text) {
      if (!text) return Promise.resolve(false);
      const write = navigator.clipboard?.writeText?.(text);
      if (write) {
        return write.then(() => true).catch(() => coforgeExecCommandCopy(text));
      }
      return Promise.resolve(coforgeExecCommandCopy(text));
    }
    function coforgeExecCommandCopy(text) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
    function coforgeDesktopCopyOut() {
      const attempt = (left) =>
        fetch(\`\${base}/clipboard\${query}\`)
          .then((res) => (res.ok ? res.text() : ""))
          .then((text) => {
            if (text) return coforgeWriteLocalClipboard(text);
            if (left <= 0) return false;
            return new Promise((resolve) => {
              window.setTimeout(() => {
                void attempt(left - 1).then(resolve);
              }, 120);
            });
          })
          .catch(() => false);
      return attempt(4);
    }
    document.addEventListener(
      "keydown",
      (ev) => {
        if (!rfb) return;
        if ((ev.ctrlKey || ev.metaKey) && (ev.code === "KeyC" || ev.code === "KeyX") && !ev.repeat) {
          ev.preventDefault();
        }
        if (!(ev.ctrlKey || ev.metaKey) || ev.code !== "KeyV" || ev.repeat) return;
        ev.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener(
      "keyup",
      (ev) => {
        if (!rfb) return;
        if ((ev.ctrlKey || ev.metaKey) && (ev.code === "KeyC" || ev.code === "KeyX") && !ev.repeat) {
          window.setTimeout(() => {
            void coforgeDesktopCopyOut();
          }, 120);
        }
        if (ev.code !== "KeyV" && ev.code !== "ControlLeft" && ev.code !== "ControlRight" && ev.code !== "MetaLeft" && ev.code !== "MetaRight") return;
        if (ev.code === "KeyV" || ev.ctrlKey || ev.metaKey) ev.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener(
      "copy",
      (ev) => {
        if (!rfb) return;
        ev.preventDefault();
        void coforgeDesktopCopyOut();
      },
      true,
    );
    document.addEventListener(
      "cut",
      (ev) => {
        if (!rfb) return;
        ev.preventDefault();
        void coforgeDesktopCopyOut();
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
