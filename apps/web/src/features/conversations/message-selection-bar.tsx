import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Copy01, DotsHorizontal, FlipForward, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { useConversationHostChannels } from "./conversation-host";
import { useOpenForward } from "./message-forward-host";
import { useSelectionIn } from "./message-selection";
import { selectedInOrder, selectedLinks, selectedMarkdown } from "./message-selection-model";

/** How long "Copy link" reads "Copied" after a copy. */
const COPIED_MS = 2000;

/**
 * Select mode's bar, in the composer's place: how many are picked, then copy their
 * links, forward them as one card, and under "…" their Markdown; × leaves.
 * Everything acts on the picked messages oldest first. Copying keeps select mode; a forward that
 * reached every destination ends it.
 */
export function MessageSelectionBar({ conversationId }: { conversationId: string }) {
  const selection = useSelectionIn(conversationId);
  const router = useRouter();
  const toast = useAppToast();
  const workspaceSlug = useWorkspaceSlug();
  const channels = useConversationHostChannels();
  const openForward = useOpenForward();
  const [copied, setCopied] = useState(false);
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
    <div className="flex justify-center px-4 pt-2 pb-[max(0.75rem,var(--spacing-safe-bottom))]">
      <div
        role="toolbar"
        aria-label={m.message_select_toolbar()}
        data-selection-bar
        className="flex max-w-full min-w-0 items-center gap-1 rounded-xl bg-primary py-1 pr-1 pl-3 shadow-lg ring-1 ring-secondary"
      >
        <span
          aria-live="polite"
          className="shrink-0 text-sm font-semibold whitespace-nowrap text-primary tabular-nums"
        >
          {m.message_select_count({ count })}
        </span>
        <Button
          size="sm"
          color="tertiary"
          iconLeading={Copy01}
          isDisabled={count === 0}
          onClick={() =>
            copy(selectedLinks(messages, linkOf), m.message_select_links_copied({ count }), () =>
              setCopied(true),
            )
          }
          // On a phone the bar holds its icon only, so the whole bar fits the width.
          className="ml-1 shrink-0 max-sm:*:data-text:sr-only"
        >
          {copied ? m.message_select_copied() : m.message_select_copy_links()}
        </Button>
        <Button
          size="sm"
          iconLeading={FlipForward}
          isDisabled={count === 0 || !openForward}
          onClick={() => openForward?.({ messages, conversationId, onForwarded: selection.exit })}
          className="shrink-0"
        >
          {m.message_forward_action()}
        </Button>
        <Dropdown.Root>
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={DotsHorizontal}
            tooltip={m.message_select_more()}
            aria-label={m.message_select_more()}
            isDisabled={count === 0}
          />
          <Dropdown.Popover placement="top end" className="w-max min-w-40">
            <Dropdown.Menu aria-label={m.message_select_more()}>
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
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={XClose}
          tooltip={m.message_select_exit()}
          aria-label={m.message_select_exit()}
          onClick={selection.exit}
        />
      </div>
    </div>
  );
}
