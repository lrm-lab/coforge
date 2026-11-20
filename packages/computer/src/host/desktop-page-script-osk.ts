/** Injected phone browser OSK helpers for desktop proxy adaptation. */

export const DESKTOP_PAGE_OSK_SCRIPT = `
    const phoneOsk = document.getElementById("coforge-desktop-osk");
    let phoneOskOpen = false;
    let oskComposeActive = false;
    const stickyMods = { ControlLeft: false, AltLeft: false, MetaLeft: false };
    const MOD_KEYSYMS = { ControlLeft: 0xffe3, AltLeft: 0xffe9, MetaLeft: 0xffeb };
    let oskShift = false;
    function syncOskLandscape() {
      if (!phoneOsk) return;
      phoneOsk.classList.toggle("is-landscape", window.innerWidth > window.innerHeight);
    }
    function syncOskModButtons() {
      phoneOsk?.querySelectorAll("button[data-osk-mod]").forEach((button) => {
        const code = button.dataset.oskMod;
        button.classList.toggle("is-active", !!stickyMods[code]);
      });
      phoneOsk?.querySelectorAll('button[data-osk-action="shift"]').forEach((button) => {
        button.classList.toggle("is-active", oskShift);
      });
      phoneOsk?.querySelectorAll('button[data-osk-action="compose"]').forEach((button) => {
        button.classList.toggle("is-active", oskComposeActive);
      });
      phoneBar?.querySelectorAll('button[data-action="keyboard"]').forEach((button) => {
        button.classList.toggle("is-active", phoneOskOpen);
      });
    }
    function focusRemoteSession() {
      if (!rfb) return;
      try {
        rfb.focus({ preventScroll: true });
      } catch {
        try {
          rfb.focus();
        } catch {
        }
      }
    }
    function setPhoneOskOpen(open) {
      if (!phone) return;
      phoneOskOpen = !!open;
      phoneOsk?.classList.toggle("is-open", phoneOskOpen);
      phoneOsk?.setAttribute("aria-hidden", phoneOskOpen ? "false" : "true");
      if (phoneOskOpen) {
        setPhoneTrayOpen(false);
        syncOskLandscape();
        focusRemoteSession();
      } else {
        oskComposeActive = false;
        oskPauseViewport = false;
        const kbInput = document.getElementById("coforge-desktop-keyboard-input");
        if (kbInput && document.activeElement === kbInput) kbInput.blur();
      }
      syncOskModButtons();
    }
    function sendModKey(code, down) {
      const keysym = MOD_KEYSYMS[code];
      if (keysym === undefined || !rfb) return;
      try {
        rfb.sendKey(keysym, code, down);
      } catch {
      }
    }
    function withStickyMods(sendBody) {
      const active = Object.keys(stickyMods).filter((code) => stickyMods[code]);
      for (const code of active) sendModKey(code, true);
      try {
        sendBody();
      } finally {
        for (const code of active) sendModKey(code, false);
        for (const code of active) stickyMods[code] = false;
        syncOskModButtons();
      }
    }
    function oskSendChar(ch) {
      if (!ch) return;
      let out = ch;
      if (oskShift && ch.length === 1 && ch >= "a" && ch <= "z") out = ch.toUpperCase();
      withStickyMods(() => sendTypedCharacter(out));
      if (oskShift) {
        oskShift = false;
        syncOskModButtons();
      }
    }
    function oskSendKeysym(keysym, code = "Unidentified") {
      withStickyMods(() => sendKeysym(keysym, code));
    }
    function openComposeInput() {
      const kbInput = document.getElementById("coforge-desktop-keyboard-input");
      if (!kbInput) return;
      oskComposeActive = true;
      oskPauseViewport = true;
      syncOskModButtons();
      try {
        kbInput.focus({ preventScroll: true });
      } catch {
        kbInput.focus();
      }
    }
    function coforgeAttachPhoneOsk() {
      if (!phone || !phoneOsk || phoneOsk.dataset.bound === "1") return;
      phoneOsk.dataset.bound = "1";
      const kbButton = phoneBar?.querySelector('button[data-action="keyboard"]');
      kbButton?.addEventListener("click", (ev) => {
        ev.preventDefault();
        setPhoneOskOpen(!phoneOskOpen);
      });
      phoneOsk.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      phoneOsk.addEventListener("click", (ev) => {
        const button = ev.target?.closest?.("button");
        if (!button || !phoneOsk.contains(button)) return;
        ev.preventDefault();
        const action = button.dataset.oskAction;
        if (action === "close") {
          setPhoneOskOpen(false);
          return;
        }
        if (action === "compose") {
          openComposeInput();
          return;
        }
        if (action === "shift") {
          oskShift = !oskShift;
          syncOskModButtons();
          return;
        }
        if (action === "layer-sym") {
          phoneOsk.dataset.layer = "sym";
          return;
        }
        if (action === "layer-abc") {
          phoneOsk.dataset.layer = "abc";
          return;
        }
        const mod = button.dataset.oskMod;
        if (mod) {
          stickyMods[mod] = !stickyMods[mod];
          syncOskModButtons();
          return;
        }
        const named = button.dataset.oskKey;
        if (named) {
          withStickyMods(() => {
            sendKey(named, true);
            sendKey(named, false);
          });
          return;
        }
        const keysymRaw = button.dataset.oskKeysym;
        if (keysymRaw) {
          oskSendKeysym(Number(keysymRaw));
          return;
        }
        const ch = button.dataset.oskChar;
        if (ch !== undefined) oskSendChar(ch);
      });
      window.addEventListener("resize", syncOskLandscape);
      syncOskLandscape();
    }
    function flushComposeInput(kbInput) {
      const text = kbInput.value;
      if (!text) return;
      kbInput.value = "";
      for (const ch of text) sendTypedCharacter(ch);
    }
    function coforgeAttachPhoneKeyboard() {
      const kbInput = document.getElementById("coforge-desktop-keyboard-input");
      if (!phone || !kbInput || kbInput.dataset.bound === "1") return;
      kbInput.dataset.bound = "1";
      kbInput.setAttribute("lang", "zh-CN");
      kbInput.setAttribute("inputmode", "text");
      kbInput.setAttribute("enterkeyhint", "done");
      kbInput.addEventListener("focus", () => {
        oskComposeActive = true;
        oskPauseViewport = true;
        syncOskModButtons();
      });
      kbInput.addEventListener("blur", () => {
        oskComposeActive = false;
        oskPauseViewport = false;
        syncOskModButtons();
        focusRemoteSession();
      });
      kbInput.addEventListener("compositionend", () => {
        flushComposeInput(kbInput);
      });
      kbInput.addEventListener("keydown", (ev) => {
        if (!rfb) return;
        if (ev.isComposing) return;
        if (ev.key === "Backspace") {
          ev.preventDefault();
          sendKeysym(0xff08, "Backspace");
          return;
        }
        if (ev.key === "Enter") {
          ev.preventDefault();
          flushComposeInput(kbInput);
          sendKeysym(0xff0d, "Enter");
          kbInput.blur();
          return;
        }
        if (ev.key === "Tab") {
          ev.preventDefault();
          sendKey("Tab", true);
          sendKey("Tab", false);
        }
      });
      kbInput.addEventListener("input", (ev) => {
        if (ev.isComposing) return;
        flushComposeInput(kbInput);
      });
    }
`;
