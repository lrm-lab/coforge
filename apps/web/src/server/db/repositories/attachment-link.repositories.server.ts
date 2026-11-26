import type { Prisma } from "#src/generated/prisma/client";

export async function linkMessageAttachments(
  tx: Pick<Prisma.TransactionClient, "attachment" | "$executeRaw">,
  messageId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const positionsById = new Map<string, number>();
  for (let index = 0; index < attachmentIds.length; index += 1) {
    positionsById.set(attachmentIds[index]!, index);
  }
  if (positionsById.size === 1) {
    const [[id, position]] = positionsById.entries();
    await tx.attachment.update({
      where: { id: id! },
      data: { messageId, position },
    });
    return;
  }
  const entries = [...positionsById.entries()].sort(([a], [b]) => a.localeCompare(b));
  await tx.$executeRaw`UPDATE "attachments" AS a
    SET "messageId" = ${messageId}::uuid, "position" = v."position"
    FROM unnest(
      ${entries.map(([id]) => id)}::uuid[],
      ${entries.map(([, position]) => position)}::int[]
    ) AS v("id", "position")
    WHERE a."id" = v."id"`;
}
