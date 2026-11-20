/** Injected noVNC clipboard helpers for desktop proxy adaptation. */

export const DESKTOP_PAGE_CLIPBOARD_SCRIPT = `
    function coforgePushRemoteClipboard(text) {
      if (!text) return Promise.resolve(false);
      return fetch(\`\${base}/clipboard\${query}\`, {
        method: "POST",
        body: text,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      })
        .then((res) => res.ok)
        .catch(() => false);
    }
    function coforgeDesktopPaste(text) {
      return coforgePushRemoteClipboard(text).then((ok) => {
        if (!ok) return;
        try {
          rfb.sendKey(0xffe3, "ControlLeft", true);
          rfb.sendKey(0x0076, "KeyV", true);
          rfb.sendKey(0x0076, "KeyV", false);
          rfb.sendKey(0xffe3, "ControlLeft", false);
        } catch {
        }
      });
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
`;
