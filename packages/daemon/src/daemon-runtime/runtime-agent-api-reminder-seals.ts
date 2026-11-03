import type { LocalReminderLocalResponse, LocalReminderRequest } from "@lrm/coforge-sdk/internal";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { isReminderId } from "@lrm/coforge-sdk/internal";

/** The App Inbox identity a reminder revision's seal names. */
const REMINDER_SEAL_IDENTITY = {
  appId: "system.reminder",
  notificationClass: "due",
  sourceKind: "reminder",
} as const;

export type ReminderSealPorts = {
  inboxCoordinator: AgentInboxCoordinator;
};

const isReminderSeal = (seal: { appId: string; notificationClass: string; sourceKind: string }) =>
  seal.appId === REMINDER_SEAL_IDENTITY.appId &&
  seal.notificationClass === REMINDER_SEAL_IDENTITY.notificationClass &&
  seal.sourceKind === REMINDER_SEAL_IDENTITY.sourceKind;

/**
 * Seals or unseals the App Inbox source identities of one reminder revision set. A seal without a
 * revision names the source alone; `--all-pending` names every revision the App Inbox holds for it
 * now. An unseal with neither removes only the revision-less seal, matching how it was placed.
 */
export async function sealReminder(
  ports: ReminderSealPorts,
  agentId: string,
  request: LocalReminderRequest,
): Promise<LocalReminderLocalResponse> {
  const reminderId = request.reminderId!;
  if (!isReminderId(reminderId)) throw new Error("invalid reminder ID; full UUID required");
  const seals = await ports.inboxCoordinator.appSeals(agentId);
  if (request.operation === "unseal") {
    const revision = request.revision === undefined ? undefined : String(request.revision);
    const removed = await seals.unseal(
      (seal) =>
        isReminderSeal(seal) &&
        seal.sourceId === reminderId &&
        (request.allPending === true
          ? true
          : revision === undefined
            ? seal.sourceRevision === undefined
            : seal.sourceRevision === revision),
    );
    if (removed === 0) return { accepted: false, reason: "no-matching-seal", reminderId };
    return { accepted: true, reminderId, sealed: removed };
  }
  const revisions =
    request.allPending === true
      ? await ports.inboxCoordinator.appItemRevisions(
          agentId,
          REMINDER_SEAL_IDENTITY.appId,
          REMINDER_SEAL_IDENTITY.notificationClass,
          reminderId,
        )
      : [request.revision === undefined ? undefined : String(request.revision)];
  if (request.allPending === true && revisions.length === 0)
    return { accepted: false, reason: "no-live-revision", reminderId };
  const sealed = await seals.seal(
    revisions.map((revision) => ({
      ...REMINDER_SEAL_IDENTITY,
      sourceId: reminderId,
      ...(revision === undefined ? {} : { sourceRevision: revision }),
      owner: request.owner!,
      until: request.until!,
    })),
  );
  return { accepted: true, reminderId, sealed, owner: request.owner, until: request.until };
}

/**
 * The seal that stops a reminder's own lifecycle change, if the Agent placed one: cancel, snooze
 * and update would otherwise mutate the very revision the Agent froze.
 */
export async function sealedReminderConflict(
  ports: Pick<ReminderSealPorts, "inboxCoordinator">,
  agentId: string,
  reminderId: string,
): Promise<LocalReminderLocalResponse | undefined> {
  const seals = await ports.inboxCoordinator.appSeals(agentId);
  const seal = seals.list().find((entry) => isReminderSeal(entry) && entry.sourceId === reminderId);
  return seal
    ? { accepted: false, reason: "sealed", owner: seal.owner, until: seal.until, reminderId }
    : undefined;
}
