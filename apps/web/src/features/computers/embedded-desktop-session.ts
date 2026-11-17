/** Phases for the in-page Agent desktop thumbnail (sleep → overlay → mini). */
export type EmbeddedDesktopPhase = "sleeping" | "maximized" | "activeMini";

export type EmbeddedDesktopEvent = "wake" | "collapse" | "sleep" | "idleExpired";

/** After collapse, disconnect the stream if the user does not maximize again. */
export const EMBEDDED_DESKTOP_IDLE_SLEEP_MS = 60_000;

export function reduceEmbeddedDesktop(
  phase: EmbeddedDesktopPhase,
  event: EmbeddedDesktopEvent,
): EmbeddedDesktopPhase {
  switch (event) {
    case "wake":
      return "maximized";
    case "collapse":
      return phase === "maximized" ? "activeMini" : phase;
    case "sleep":
    case "idleExpired":
      return "sleeping";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Whether the desktop iframe should stay mounted (stream connected). */
export function embeddedDesktopStreamActive(phase: EmbeddedDesktopPhase): boolean {
  return phase === "maximized" || phase === "activeMini";
}

/** Idle countdown runs only while the session is active but minimized. */
export function embeddedDesktopIdleCountdownActive(phase: EmbeddedDesktopPhase): boolean {
  return phase === "activeMini";
}
