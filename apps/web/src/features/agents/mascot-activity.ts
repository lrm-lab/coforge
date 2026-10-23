import type { agentDisplay } from "./agent-activity-presentation";
import type { MascotActivity } from "./mascot-rive-contract";

/** What `agentDisplay` calls an Agent's state: the cloud's activity kinds, or `unknown` before any
 * display has arrived. */
type DisplayKind = ReturnType<typeof agentDisplay>["kind"];

/**
 * What a mascot acts out for an Agent's presented state (`agentDisplay(display).kind`). `online`
 * and a display not yet received both rest: an unknown status is not offline, so the mascot does
 * not sleep on it.
 */
export function mascotActivity(kind: DisplayKind): MascotActivity {
  switch (kind) {
    case "working":
    case "thinking":
    case "error":
    case "offline":
      return kind;
    default:
      return "idle";
  }
}
