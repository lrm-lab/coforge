import type { AppRegistrationNotice } from "@lrm/coforge-sdk/internal/app-registration-notice";
import { APP_REGISTRATION_NOTICE_SOURCE, APP_REGISTRY_SECRET_CLASS } from "./registry";
import type { MintAppItem } from "./agent-app-inbox";

/**
 * Hands a new app's client secret to its owner Agent as a transient App Inbox item. The notice is
 * private and best effort: it reaches only an Agent that is running here, the item lives in this
 * process's memory (never on disk, in a log or in the cloud), the Agent's first read consumes it,
 * and the inbox forgets it after `APP_CLIENT_SECRET_TTL_MS` otherwise. An Agent that missed it
 * runs `coforge app rotate-secret`.
 */
export async function acceptAppRegistrationNotice(
  notice: AppRegistrationNotice,
  deps: {
    isRunning(agentId: string): boolean;
    mint(agentId: string, item: MintAppItem): Promise<unknown>;
  },
): Promise<boolean> {
  if (!deps.isRunning(notice.agentId)) return false;
  await deps.mint(notice.agentId, {
    appId: APP_REGISTRATION_NOTICE_SOURCE,
    notificationClass: APP_REGISTRY_SECRET_CLASS,
    sourceRef: { kind: "app_registration", id: notice.appKey, revision: "1" },
    title: `Registered app ${notice.appName}`.slice(0, 120),
    summary: `Client secret for ${notice.appKey} (shown once; store it, never post it): ${notice.clientSecret}`,
  });
  return true;
}
