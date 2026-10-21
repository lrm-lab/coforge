/**
 * One Agent's screen on the cloud computer image.
 *
 * The image listens on 127.0.0.1 only. A computer without that service
 * (a local Computer, or an image from before per-agent screens) answers
 * nothing, and the launch continues on the shared desktop.
 */

const SCREEN_FIELDS = {
  display: "DISPLAY",
  xauthority: "XAUTHORITY",
  configHome: "XDG_CONFIG_HOME",
  dataHome: "XDG_DATA_HOME",
  cacheHome: "XDG_CACHE_HOME",
  runtimeDir: "XDG_RUNTIME_DIR",
  dbus: "DBUS_SESSION_BUS_ADDRESS",
} as const;

const AGENT_ID = /^[A-Za-z0-9_-]+$/;

/** The display and per-agent directories the image returns for one hold. */
export function agentDesktopEnvironment(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const environment: Record<string, string> = {};
  for (const [field, name] of Object.entries(SCREEN_FIELDS)) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) continue;
    environment[name] = trimmed;
  }
  return environment;
}

function screenPort(): string | undefined {
  const port = Bun.env.COFORGE_AGENT_SCREEN_PORT ?? "6091";
  if (!/^\d+$/.test(port)) return undefined;
  const number = Number(port);
  if (number < 1 || number > 65535) return undefined;
  return String(number);
}

type ScreenRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Starts that Agent's screen if needed and returns the env for its process. */
export async function holdAgentDesktop(
  agentId: string,
  fetchImpl: ScreenRequest = fetch,
): Promise<Record<string, string>> {
  if (!AGENT_ID.test(agentId)) return {};
  const port = screenPort();
  if (!port) return {};
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/screen/${agentId}`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return {};
    return agentDesktopEnvironment(await response.json());
  } catch {
    return {};
  }
}

/** Drops the Agent's hold. A browser that is still watching keeps the screen. */
export async function releaseAgentDesktop(
  agentId: string,
  fetchImpl: ScreenRequest = fetch,
): Promise<void> {
  if (!AGENT_ID.test(agentId)) return;
  const port = screenPort();
  if (!port) return;
  try {
    await fetchImpl(`http://127.0.0.1:${port}/screen/${agentId}/release`, {
      method: "POST",
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // The image stops an unheld screen once nobody is watching.
  }
}
