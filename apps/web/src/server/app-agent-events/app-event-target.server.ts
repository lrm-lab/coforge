import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

/**
 * The target an Agent reads an app's events by: `@app.<app key>`. A direct-conversation target
 * (`@user`) never has a dot, so the two cannot collide, and the daemon and the codec accept any
 * target that starts with `@`: the dedicated conversation needs no wire change.
 */
export const APP_EVENT_TARGET = /^@app\.([a-z][a-z0-9-]{2,63})$/;

export const appEventTarget = (appKey: string) => `@app.${appKey}`;

/** The key of the dedicated conversation of an app and an Agent (`Conversation.directKey`); it
 * matches no direct conversation between people or with a person, so no list holds it. */
export const appEventDirectKey = (appId: string, agentId: string) =>
  `app:${appId}|agent:${agentId}`;

/** `Conversation.kind` of an app's dedicated conversation with an Agent. */
export const APP_EVENTS_KIND = "app_events";

/**
 * The one seam the Agent target resolution calls for an app's events. `undefined` when
 * `parentTarget` (the part before any `:`) is not an app's target. For a read, the Agent's
 * dedicated conversation with that app (kind `app_events`, with the Agent a member): NOT_FOUND for
 * an app that never sent or does not exist, alike. For a send (`send: true`) it is always refused,
 * ACCESS_DENIED: an Agent reads what an app sent but never posts there.
 */
export async function appEventConversation(
  db: Pick<PrismaClient, "appAgentEvent">,
  workspaceId: string,
  agentId: string,
  parentTarget: string,
  { send = false }: { send?: boolean } = {},
): Promise<{ id: string } | undefined> {
  const key = APP_EVENT_TARGET.exec(parentTarget)?.[1];
  if (!key) return undefined;
  if (send) throw new AppError("ACCESS_DENIED");
  const event = await db.appAgentEvent.findFirst({
    where: {
      agentId,
      workspaceId,
      app: { key },
      message: {
        conversation: { kind: APP_EVENTS_KIND, members: { some: { agentId, leftAt: null } } },
      },
    },
    select: { conversationId: true },
  });
  if (!event) throw new AppError("NOT_FOUND");
  return { id: event.conversationId };
}
