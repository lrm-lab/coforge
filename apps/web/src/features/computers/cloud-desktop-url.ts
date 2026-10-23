/**
 * Browser address of one cloud Computer's desktop.
 *
 * `desktopOrigin` is the deployment's Swarm host proxy
 * (`COFORGE_CLOUD_DESKTOP_ORIGIN`), not the web page the user is on. The image
 * serves that page at `/desktop.html` and connects to a relative `websockify`.
 * The host proxy publishes the computer at `/desktop/<computer id>/` and one
 * Agent's screen at `/desktop/<computer id>/<agent id>/`. It adds the
 * container token on its own request, so this address has none. An Agent's
 * name, when present, is the `title` query and becomes the window title.
 */
export function cloudDesktopUrl(
  desktopOrigin: string,
  computerId: string,
  agentId?: string,
  title?: string,
): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(computerId)) return undefined;
  if (agentId !== undefined && !/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
  let origin: URL;
  try {
    origin = new URL(desktopOrigin);
  } catch {
    return undefined;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return undefined;
  if (!origin.hostname || origin.username || origin.password) return undefined;
  if (origin.pathname !== "" && origin.pathname !== "/") return undefined;
  if (origin.search || origin.hash) return undefined;
  const desktop = new URL(`${origin.protocol}//desktop.invalid/`);
  desktop.hostname = origin.hostname;
  desktop.port = origin.port;
  desktop.pathname = agentId ? `/desktop/${computerId}/${agentId}/` : `/desktop/${computerId}/`;
  // 80 is the Agent display-name cap. The proxy applies the same cap again.
  const windowTitle = title
    ?.replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 80);
  if (windowTitle) desktop.searchParams.set("title", windowTitle);
  return desktop.toString();
}

/** A sized popup. The window name is what reuses it; `noopener` would discard that name. */
export const CLOUD_DESKTOP_WINDOW_FEATURES = "popup,width=1280,height=800";

/** One window per desktop. The desktop page keeps `window.opener`, so this name still selects it. */
export function cloudDesktopWindowName(computerId: string, agentId?: string): string {
  return agentId ? `coforge-desktop-${computerId}-${agentId}` : `coforge-desktop-${computerId}`;
}

export function openCloudDesktopWindow(url: string, computerId: string, agentId?: string): void {
  const name = cloudDesktopWindowName(computerId, agentId);
  // The same features every time. A call without them does not raise the popup, and a call that
  // loads `url` again reconnects the desktop. An empty URL selects the existing named window.
  // A fresh popup is `about:blank` and then loads the desktop; an already-open desktop is another
  // origin, so reading its location fails and it is left as it is.
  const opened = window.open("", name, CLOUD_DESKTOP_WINDOW_FEATURES);
  if (!opened) return;
  try {
    if (opened.location.href === "about:blank") opened.location.href = url;
  } catch {
    // The named desktop is already open.
  }
}
