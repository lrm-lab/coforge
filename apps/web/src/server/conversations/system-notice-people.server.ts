import type { PrismaClient } from "#src/generated/prisma/client";
import { APP_BOT_LOGO_SELECT } from "#src/server/apps/app-logo.server";
import { browserSenderAvatarUrl } from "./sender-display.server";

/** Who a person named in a system notice is, as the web draws their face: the user or Agent id
 * behind the member row, and their avatar. */
export type SystemPersonFace = {
  kind: "user" | "agent";
  id: string;
  avatarUrl: string | null;
};

/** The `SystemPerson.memberId`s a notice's params name, wherever in them the people sit. */
export function noticeMemberIds(params: unknown): string[] {
  const ids: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (typeof row.memberId === "string") ids.push(row.memberId);
      Object.values(row).forEach(walk);
    }
  };
  walk(params);
  return ids;
}

/**
 * The faces of every person the notices on a page name, in one query for the whole page. Read
 * from the member rows whether or not the member has since left (`leftAt` is a soft leave, the row
 * stays) or the Agent was archived: a notice that says "Frank removed qa2" is about someone who is
 * no longer in the conversation, so the conversation's current members cannot draw them. A
 * message's sender gets the same treatment, resolved from its member row.
 */
export async function systemNoticeFaces(
  db: Pick<PrismaClient, "conversationMember">,
  messages: readonly { systemMessage?: { params: unknown } | null }[],
  workspaceId: string,
): Promise<ReadonlyMap<string, SystemPersonFace>> {
  const memberIds = [
    ...new Set(
      messages.flatMap((m) => (m.systemMessage ? noticeMemberIds(m.systemMessage.params) : [])),
    ),
  ];
  if (memberIds.length === 0) return new Map();
  const rows = await db.conversationMember.findMany({
    where: { id: { in: memberIds }, workspaceId },
    select: {
      id: true,
      userId: true,
      agentId: true,
      user: { select: { avatarObjectKey: true } },
      agent: { select: { avatarMascot: true, appBot: APP_BOT_LOGO_SELECT } },
    },
  });
  const faces = new Map<string, SystemPersonFace>();
  for (const row of rows) {
    const id = row.userId ?? row.agentId;
    if (!id) continue;
    faces.set(row.id, {
      kind: row.userId ? "user" : "agent",
      id,
      avatarUrl: browserSenderAvatarUrl(row, workspaceId),
    });
  }
  return faces;
}

/** The faces of the people one notice names, keyed by member id; absent when it names none. */
export function noticeFacesOf(
  params: unknown,
  faces: ReadonlyMap<string, SystemPersonFace> | undefined,
): Record<string, SystemPersonFace> | undefined {
  const named = noticeMemberIds(params).flatMap((id) => {
    const face = faces?.get(id);
    return face ? [[id, face] as const] : [];
  });
  return named.length > 0 ? Object.fromEntries(named) : undefined;
}
