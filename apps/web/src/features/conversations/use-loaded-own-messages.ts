import { useMemo } from "react";
import { attachmentFileNameSummary } from "./attachment-file-name";
import { isViewerMessage } from "./own-message";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";

type OwnMessageSource = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  senderMemberId?: string | null;
  attachments: AttachmentView[];
};

/** Builds the fallback own-message index from the currently loaded page. */
export function useLoadedOwnMessages(
  messages: readonly OwnMessageSource[],
  senderMemberId: string | undefined,
  onLoadOwnMessages: unknown,
) {
  return useMemo(
    () =>
      onLoadOwnMessages
        ? []
        : messages
            .filter((message) => isViewerMessage(message, senderMemberId))
            .sort((left, right) => left.sequence - right.sequence)
            .map((message) => ({
              id: message.id,
              sequence: message.sequence,
              body: message.body,
              createdAt: message.createdAt,
              attachmentFileName: attachmentFileNameSummary(message.attachments),
            })),
    [messages, senderMemberId, onLoadOwnMessages],
  );
}
