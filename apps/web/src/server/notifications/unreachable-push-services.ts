/**
 * Push services CoForge's servers cannot reach (task #568, Frank's decision on #469): they run in
 * mainland China, where Google's and Apple's push endpoints time out. Chrome, Edge on Android and
 * other Chromium browsers subscribe at Google; Safari, and every browser on an iPhone, at Apple.
 * Firefox (Mozilla) and Edge on Windows (WNS) are reachable.
 */
export type UnreachablePushService = "google" | "apple";

export function unreachablePushService(endpoint: string): UnreachablePushService | null {
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
