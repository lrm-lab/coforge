import { createContext, useContext, useState, type ReactNode } from "react";

import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { MessageForwardDialog } from "./message-forward-dialog";
import type { ForwardSource, ForwardSourceMessage } from "./message-forward-model";
import type { ChannelSuggestion } from "./reference-completion";

/** Opens the dialog for one message, or a selection, oldest first. */
type OpenForward = (input: {
  messages: readonly ForwardSourceMessage[];
  conversationId: string;
  /** Called once every destination took it. */
  onForwarded?: () => void;
}) => void;

const OpenForwardContext = createContext<OpenForward | null>(null);

/** Opens the Forward dialog for messages; null where no conversation host is above (rows then
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
  const [opened, setOpened] = useState<{ source: ForwardSource; onForwarded?: () => void } | null>(
    null,
  );
  const open = useLatestCallback<Parameters<OpenForward>, void>(
    ({ messages, conversationId, onForwarded }) => {
      const conversationName = channels.find((channel) => channel.id === conversationId)?.name;
      setOpened({
        source: { messages, conversationId, conversationName: conversationName ?? null },
        onForwarded,
      });
    },
  );
  return (
    <OpenForwardContext value={open}>
      {children}
      {opened && (
        <MessageForwardDialog
          source={opened.source}
          onForwarded={opened.onForwarded}
          onClose={() => setOpened(null)}
        />
      )}
    </OpenForwardContext>
  );
}
