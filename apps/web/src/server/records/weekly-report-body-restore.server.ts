import type { PrismaClient } from "#src/generated/prisma/client";
import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";
import { RecordCatalog } from "./record-catalog.server";
import { parseWeeklyReportAssistantSuggestion } from "./weekly-report-assistant-suggestion.server";

/**
 * When the member's weekly-report assistant sends a body-edit, write it at once.
 * Another agent, a channel message, or any other envelope does not write.
 */
export async function applyIncomingWeeklyReportBodyEdit(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    target: string;
    messageId: string;
    body: string;
  },
): Promise<void> {
  if (!input.target.startsWith("@") || isChannelMessageTarget(input.target)) return;
  const suggestion = parseWeeklyReportAssistantSuggestion(input.body);
  if (suggestion?.type !== "body-edit") return;
  const username = input.target.slice(1).split(":")[0]?.trim();
  if (!username) return;
  const user = await db.user.findUnique({
    where: { username },
    select: { id: true },
  });
  if (!user) return;
  const assistant = await db.weeklyReportAssistant.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
    select: { agentId: true },
  });
  if (assistant?.agentId !== input.agentId) return;
  await new RecordCatalog(db).applyConfirmedReportBody({
    workspaceId: input.workspaceId,
    userId: user.id,
    reportId: suggestion.reportId,
    content: suggestion.content,
    sourceMessageId: input.messageId,
  });
}
