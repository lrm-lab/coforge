/**
 * Browser address of one cloud Computer's desktop.
 *
 * `desktopOrigin` is the deployment's Swarm host proxy
 * (`COFORGE_CLOUD_DESKTOP_ORIGIN`), not the web page the user is on. The image
 * serves that page at `/desktop.html` and connects to a relative `websockify`.
 * The host proxy publishes it at `/desktop/<computer id>/` and adds the
 * container token on its own request, so this address has none.
 */
export function cloudDesktopUrl(desktopOrigin: string, computerId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(computerId)) return undefined;
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
  desktop.pathname = `/desktop/${computerId}/`;
  return desktop.toString();
}
