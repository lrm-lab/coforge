import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";

import { browserDeviceKind } from "./browser-push";
import { reportComputerActivity } from "./notification-settings.functions";

/** How often the focused page says the person is at this computer (task #467). */
export const ACTIVITY_REPORT_MS = 60_000;

/** Whether this page should report now: a computer's, visible and focused (so one tab only). */
export function shouldReportActivity(page: {
  kind: "desktop" | "mobile";
  visible: boolean;
  focused: boolean;
}): boolean {
  return page.kind === "desktop" && page.visible && page.focused;
}

/**
 * Tells the server, every minute while this computer's CoForge page is visible and focused, when
 * the person last typed or pointed in it, so a phone's notifications can wait while they are here
 * (the "while I am at my computer" setting). Input or not, it reports: the server counts the idle
 * minutes from the last input. Only input in CoForge counts. A phone never reports.
 */
export function useComputerActivityReport(enabled: boolean) {
  const report = useServerFn(reportComputerActivity);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (browserDeviceKind(navigator.userAgent, navigator.maxTouchPoints) !== "desktop") return;
    let lastInputAt = Date.now();
    const onInput = () => {
      lastInputAt = Date.now();
    };
    const send = () => {
      const page = {
        kind: "desktop" as const,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      };
      if (!shouldReportActivity(page)) return;
      void report({ data: { lastInputAt: new Date(lastInputAt).toISOString() } }).catch(() => {});
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const type of events) window.addEventListener(type, onInput, { passive: true });
    window.addEventListener("focus", send);
    const timer = window.setInterval(send, ACTIVITY_REPORT_MS);
    send();
    return () => {
      for (const type of events) window.removeEventListener(type, onInput);
      window.removeEventListener("focus", send);
      window.clearInterval(timer);
    };
  }, [enabled, report]);
}

/** `useComputerActivityReport` as an element, for the Workspace layout; renders nothing. */
export function ComputerActivityReport({ enabled }: { enabled: boolean }) {
  useComputerActivityReport(enabled);
  return null;
}
