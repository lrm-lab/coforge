/** postMessage from the phone desktop iframe (cross-origin desktop host). */
export const DESKTOP_SHELL_MESSAGE_FLAG = "coforgeDesktop";

export type DesktopShellAction = "minimize" | "sleep" | "toggle-landscape";

export function desktopShellActionFromMessage(data: unknown): DesktopShellAction | undefined {
  if (!data || typeof data !== "object") return undefined;
  const body = data as { coforgeDesktop?: unknown; action?: unknown };
  if (body.coforgeDesktop !== true || typeof body.action !== "string") return undefined;
  if (body.action === "minimize" || body.action === "sleep" || body.action === "toggle-landscape") {
    return body.action;
  }
  return undefined;
}
