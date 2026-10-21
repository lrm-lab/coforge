/** The Swarm host desktop proxy port (`COFORGE_DESKTOP_PROXY_PORT`, default 6090). */
const CLOUD_DESKTOP_PROXY_PORT = "6090";

/**
 * Browser address of one cloud Computer's desktop.
 *
 * The image serves that page at `/desktop.html` and connects to a relative
 * `websockify`. The host proxy publishes it at `/desktop/<computer id>/` and
 * adds the container token on its own request, so this address has none.
 */
export function cloudDesktopUrl(pageUrl: string, computerId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(computerId)) return undefined;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return undefined;
  if (!page.hostname) return undefined;
  const desktop = new URL("http://desktop.invalid/");
  desktop.hostname = page.hostname;
  desktop.port = CLOUD_DESKTOP_PROXY_PORT;
  desktop.pathname = `/desktop/${computerId}/`;
  return desktop.toString();
}
