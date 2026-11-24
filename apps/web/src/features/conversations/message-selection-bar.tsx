import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Copy01, DotsHorizontal, FlipForward, Image01 } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import {
  SelectionActionBar,
  SelectionActionButton,
  SelectionActionIconButton,
  SelectionActionPrimaryButton,
} from "#src/components/ui/selection-action-bar";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { useConversationHostChannels } from "./conversation-host";
import { useOpenForward } from "./message-forward-host";
import { useSelectionIn } from "./message-selection";
import { selectedInOrder, selectedLinks, selectedMarkdown } from "./message-selection-model";
import { MessageShareDialog } from "./message-share-dialog";

const COPIED_MS = 2000;

export function MessageSelectionBar({ conversationId }: { conversationId: string }) {
  const selection = useSelectionIn(conversationId);
  const router = useRouter();
  const toast = useAppToast();
  const workspaceSlug = useWorkspaceSlug();
  const channels = useConversationHostChannels();
  const openForward = useOpenForward();
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!selection) return null;
  const messages = selectedInOrder(selection.state);
  const count = messages.length;
  const isChannel = channels?.some((channel) => channel.id === conversationId) ?? false;
  const linkOf = (messageId: string) =>
    new URL(
      router.buildLocation(
        isChannel
          ? {
              to: "/w/$workspaceSlug/channel/$channelId",
              params: { workspaceSlug, channelId: conversationId },
              search: { message: messageId },
            }
          : {
              to: "/w/$workspaceSlug/dm/$dmId",
              params: { workspaceSlug, dmId: conversationId },
              search: { message: messageId },
            },
      ).publicHref,
      window.location.origin,
    ).href;
  const copy = (text: string, success: string, then?: () => void) =>
    void copyText(text).then((done) => {
      if (!done) return toast.error(m.conversation_copy_failed());
      toast.success(success);
      then?.();
    });
  return (
    <>
      <SelectionActionBar
        label={m.message_select_toolbar()}
        countLabel={m.message_select_count({ count })}
        clearLabel={m.message_select_exit()}
        onClear={selection.exit}
      >
        <SelectionActionPrimaryButton
          iconLeading={FlipForward}
          isDisabled={count === 0 || !openForward}
          onPress={() => openForward?.({ messages, conversationId, onForwarded: selection.exit })}
        >
          {m.message_forward_action()}
        </SelectionActionPrimaryButton>
        <SelectionActionButton
          iconLeading={Copy01}
          isDisabled={count === 0}
          onPress={() =>
            copy(selectedLinks(messages, linkOf), m.message_select_links_copied({ count }), () =>
              setCopied(true),
            )
          }
          className="max-sm:w-8 max-sm:px-0 max-sm:*:data-text:sr-only"
        >
          {copied ? m.message_select_copied() : m.message_select_copy_links()}
        </SelectionActionButton>
        <Dropdown.Root>
          <SelectionActionIconButton
            icon={DotsHorizontal}
            tooltip={m.message_select_more()}
            isDisabled={count === 0}
          />
          <Dropdown.Popover placement="top end" className="w-max min-w-40">
            <Dropdown.Menu aria-label={m.message_select_more()}>
              <Dropdown.Item
                icon={Image01}
                label={m.message_share_action()}
                onAction={() => setSharing(true)}
              />
              <Dropdown.Item
                icon={Copy01}
                label={m.conversation_copy_as_markdown()}
                onAction={() =>
                  copy(selectedMarkdown(messages), m.conversation_copy_as_markdown_success())
                }
              />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      </SelectionActionBar>
      {sharing && (
        <MessageShareDialog
          messages={messages.map(({ message }) => message)}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
