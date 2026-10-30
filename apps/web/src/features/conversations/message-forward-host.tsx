import { createContext, useContext, useState, type ReactNode } from "react";

import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { MessageForwardDialog } from "./message-forward-dialog";
import type { ForwardSource } from "./message-forward-model";
import type { ChannelSuggestion } from "./reference-completion";

type OpenForward = (input: {
  message: ForwardSource["message"];
  conversationId: string;
  plainBody: string;
}) => void;

const OpenForwardContext = createContext<OpenForward | null>(null);

/** Opens the Forward dialog for a message; null where no conversation host is above (rows then
 * offer no Forward). Stable, so a row that reads it is not re-rendered by it. */
export function useOpenForward(): OpenForward | null {
  return useContext(OpenForwardContext);
}

/**
 * The one Forward dialog a conversation host holds, opened by any row. It mounts per opening, so
 * each opening starts clean and owns its own request id.
 */
export function ForwardHost({
  channels,
  children,
}: {
  channels: readonly ChannelSuggestion[];
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<{ source: ForwardSource; plainBody: string } | null>(null);
  const open = useLatestCallback<Parameters<OpenForward>, void>(
    ({ message, conversationId, plainBody }) => {
      const conversationName = channels.find((channel) => channel.id === conversationId)?.name;
      setOpened({
        source: { message, conversationId, conversationName: conversationName ?? null },
        plainBody,
      });
    },
  );
  return (
    <OpenForwardContext value={open}>
      {children}
      {opened && (
        <MessageForwardDialog
          source={opened.source}
          plainBody={opened.plainBody}
          onClose={() => setOpened(null)}
        />
      )}
    </OpenForwardContext>
  );
}
