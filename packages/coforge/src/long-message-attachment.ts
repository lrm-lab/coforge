import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLongMessage, longMessageAsFile } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";

export const CLI_LONG_MESSAGE_NOTE = "全文见附件 / Full text in the attached file.";

export type LongMessageUploadResult = {
  body: string;
  attachmentIds: string[] | undefined;
  convertedAttachmentId?: string;
};

export async function convertLongMessageToAttachment(input: {
  body: string;
  target: string;
  existingAttachmentIds?: string[];
  upload?: (args: {
    path: string;
    target: string;
    mimeType?: string;
  }) => Promise<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
  outputMode: "text" | "json";
  now?: Date;
  draftSaved?: boolean;
  suggestedNextAction?: string;
}): Promise<LongMessageUploadResult> {
  if (!isLongMessage(input.body)) {
    return { body: input.body, attachmentIds: input.existingAttachmentIds };
  }
  if (!input.upload) {
    throw new CliError({
      code: "UPLOAD_UNAVAILABLE",
      message: "Attachment upload transport is unavailable for long message conversion.",
      retryable: false,
      outputMode: input.outputMode,
      ...(input.draftSaved !== undefined ? { draftSaved: input.draftSaved } : {}),
      ...(input.suggestedNextAction ? { suggestedNextAction: input.suggestedNextAction } : {}),
    });
  }
  const { preview, fileName, content } = longMessageAsFile(input.body, {
    note: CLI_LONG_MESSAGE_NOTE,
    now: input.now ?? new Date(),
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-long-message-"));
  const filePath = join(dir, fileName);
  try {
    await writeFile(filePath, content, "utf8");
    const uploaded = await input.upload({
      path: filePath,
      target: input.target,
      mimeType: "text/markdown",
    });
    return {
      body: preview,
      attachmentIds: [...(input.existingAttachmentIds ?? []), uploaded.id],
      convertedAttachmentId: uploaded.id,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function formatLongMessageConvertedSuffix(attachmentId?: string): string {
  return attachmentId ? `\n超长，已作为文件发送，附件 ID: ${attachmentId}` : "";
}
