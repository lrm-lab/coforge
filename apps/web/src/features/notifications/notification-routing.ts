export const MAX_NOTIFICATION_AGE_MS = 10 * 60_000;

export async function notificationRouteFingerprint(messageId: string, route: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([messageId, route]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function installationRoute(installationId: string) {
  return `installation:${installationId}`;
}

export function isFreshNotification(at: number, now: number) {
  return at >= now - MAX_NOTIFICATION_AGE_MS && at <= now + 60_000;
}

export async function pageOwnsNotification(
  event: { messageId: string; pushInstallations: readonly string[]; legacyPush: readonly string[] },
  installation: () => Promise<string>,
) {
  if (event.legacyPush.length > 0) return false;
  if (event.pushInstallations.length === 0) return true;
  const fingerprint = await notificationRouteFingerprint(
    event.messageId,
    installationRoute(await installation()),
  );
  return !event.pushInstallations.includes(fingerprint);
}
