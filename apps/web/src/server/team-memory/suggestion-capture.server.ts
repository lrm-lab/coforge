import type { Prisma } from "#src/generated/prisma/client";
import { EXPERIMENTS } from "#src/server/experiments/experiments.server";
import { taskMemorySuggestion } from "./suggestions";

export async function captureAcceptedTaskMemory(
  tx: Prisma.TransactionClient,
  task: Parameters<typeof taskMemorySuggestion>[0] & {
    conversationId: string;
    workspaceId: string;
  },
) {
  if (Bun.env.COFORGE_TEAM_MEMORY_REVIEW !== "true") return;
  const suggestion = taskMemorySuggestion(task);
  if (!suggestion) return;
  const board = await tx.conversation.findFirst({
    where: {
      id: task.conversationId,
      workspaceId: task.workspaceId,
      channelName: { not: null },
      visibility: "public",
      hiddenFromWorkspaceAt: null,
    },
    select: { workspace: { select: { experiments: true } } },
  });
  if (!board) return;
  const settings = board.workspace.experiments as Record<string, unknown> | null;
  if ((settings?.teamMemory ?? EXPERIMENTS.teamMemory.defaultEnabled) !== true) return;
  await tx.teamMemorySuggestion.createMany({
    data: {
      workspaceId: task.workspaceId,
      sourceKey: suggestion.key,
      kind: "task",
      payload: suggestion.draft,
    },
    skipDuplicates: true,
  });
}
