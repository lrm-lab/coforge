/** The push service a browser subscribes at: Google for Chrome and other Chromium browsers,
 * Apple for Safari and every browser on an iPhone. */
export type PushService = "google" | "apple";

/**
 * Push services CoForge's servers cannot reach (task #568, Frank's decision on #469): they run in
 * mainland China, where Google's push endpoints time out and Apple's hang. Firefox (Mozilla) and
 * Edge on Windows (WNS) are reachable. Take a service out once a real device has been seen to get
 * pushes from it: Settings then drops its note, and on an iPhone shows the home-screen guide again.
 */
export const UNREACHABLE_PUSH_SERVICES: ReadonlySet<PushService> = new Set(["google", "apple"]);

export function unreachablePushService(endpoint: string): PushService | null {
  const service = pushServiceOf(endpoint);
  return service && UNREACHABLE_PUSH_SERVICES.has(service) ? service : null;
}

function pushServiceOf(endpoint: string): PushService | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".googleapis.com") || host.endsWith(".google.com")) return "google";
  if (host === "web.push.apple.com" || host.endsWith(".push.apple.com")) return "apple";
  return null;
}
