import { ChannelPlace } from "./channel-name";
import { actionCardPreviewText } from "./action-card-preview";
import { Link, useRouter } from "@tanstack/react-router";
import { BookmarkCheck, Copy01, Link01, MessageTextSquare01 } from "@untitledui/icons";
import { Bookmark as BookmarkDuotone } from "kubai-icons/duotone";
import { Link as AriaLink } from "react-aria-components";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorName } from "#src/features/avatars/actor-name";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { PageHeader } from "#src/components/layout/page-header";
import { ConversationListButton } from "./conversation-list-button";
import { EmptyState } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { useSavedEntries, useSavedMessages } from "./conversation-host";
import { savedJumpTarget } from "./saved-messages-model";
import type { SavedEntry } from "./saved-messages-collection";
import { messagePlainText } from "./selection-copy";

export function SavedMessagesView() {
  const saved = useSavedMessages();
  const entries = useSavedEntries() ?? [];
  if (!saved) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={<ConversationListButton />}
        heading={m.conversation_saved_nav()}
        meta={
          <span className="shrink-0 text-sm text-tertiary tabular-nums">
            {m.conversation_saved_count({ count: entries.length })}
          </span>
        }
      />
      {entries.length === 0 ? (
        <EmptyState
          size="page"
          picture={<EmptyIcon icon={BookmarkDuotone} />}
          title={m.conversation_saved_empty_title()}
          description={m.conversation_saved_empty_description()}
        />
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {entries.map((entry) => (
            <SavedMessageCard
              key={entry.message.id}
              entry={entry}
              onSave={saved.save}
              onUnsave={saved.unsave}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function SavedMessageCard({
  entry,
  onSave,
  onUnsave,
}: {
  entry: SavedEntry;
  /** Puts the card back at once; rejects (after taking it away again) when the server refuses. */
  onSave: (entry: SavedEntry) => Promise<void>;
  /** Takes the card away at once; rejects (after putting it back) when the server refuses. */
  onUnsave: (messageId: string) => Promise<void>;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const workspaceSlug = useWorkspaceSlug();
  const { conversation, message } = entry;
  const jump = savedJumpTarget(workspaceSlug, conversation, message);
  const href = router.buildLocation(jump).publicHref;
  const place = conversation.channelName ? (
    <ChannelPlace
      id={conversation.id}
      name={conversation.channelName}
      visibility={conversation.visibility}
    />
  ) : conversation.peer ? (
    <ActorName
      actor={{
        kind: conversation.peer.kind,
        id: conversation.peer.id,
        name:
          conversation.peer.kind === "agent" && conversation.peer.handle
            ? `@${conversation.peer.handle}`
            : conversation.peer.name,
        avatarUrl: conversation.peer.avatarUrl,
        deleted: conversation.peer.deleted,
      }}
    />
  ) : message.senderKind === "agent" ? (
    `@${message.senderHandle ?? message.senderName}`
  ) : (
    <ActorName
      actor={{
        kind: "user",
        id: message.senderUserId,
        name: message.senderName,
        avatarUrl: message.senderAvatarUrl,
        deleted: message.senderDeleted,
      }}
    />
  );
  const attachmentName = message.attachments[0]?.fileName;

  function remove() {
    void onUnsave(message.id)
      .then(() =>
        toast.undoable(m.conversation_unsaved(), {
          key: message.id,
          failed: m.conversation_save_failed(),
          onUndo: () => onSave(entry),
        }),
      )
      .catch(() => toast.error(m.conversation_save_failed()));
  }

  function copy(text: string, success: string) {
    void copyText(text).then((copied) => {
      if (copied) toast.success(success);
      else toast.error(m.conversation_copy_failed());
    });
  }

  function handleAction(key: unknown) {
    if (key === "copy-link") {
      copy(new URL(href, window.location.origin).href, m.conversation_saved_link_copied());
    } else if (key === "copy-markdown" && message.body) {
      // Markdown source as typed, with mentions and task references spelled out.
      copy(
        messagePlainText({ body: message.body, mentions: message.mentions }),
        m.conversation_copy_as_markdown_success(),
      );
    } else if (key === "remove") {
      remove();
    }
  }

  return (
    // No native text selection or iOS link callout competing with the menu a long-press opens.
    <li className="flex items-start gap-2 rounded-xl border border-secondary bg-primary p-3 transition-colors select-none [-webkit-touch-callout:none] hover:bg-secondary">
      {/* The card is a React Aria link so the context menu (`MenuTrigger trigger="contextMenu"`)
          can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
          navigation (react-aria.adobe.com/Link, client-side routing). A left click stays an
          ordinary jump. */}
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          render={(props) =>
            "href" in props ? <Link {...props} {...jump} /> : <span {...props} />
          }
          className="min-w-0 flex-1 rounded-lg outline-focus-ring focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs text-tertiary">
            <span className="flex min-w-0 shrink items-center font-medium text-tertiary">
              {place}
            </span>
            {message.threadRootId && (
              <span className="inline-flex shrink-0 items-center gap-1 text-quaternary">
                <MessageTextSquare01 aria-hidden="true" className="size-3" />
                {m.conversation_thread()}
              </span>
            )}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ActorAvatar
                presence={false}
                size="xs"
                src={message.senderAvatarUrl ?? null}
                name={message.senderName}
                deleted={message.senderDeleted}
                alt=""
                className="size-4 shrink-0"
              />
              <span className="truncate font-semibold text-secondary">{message.senderName}</span>
            </span>
            <span className="ms-auto shrink-0 whitespace-nowrap tabular-nums">
              <RelativeTime value={message.createdAt} />
            </span>
          </div>
          {/* Every card is the same size: a plain-text excerpt in one type size, always two lines
              tall, the rest hidden. */}
          <p className="mt-1 line-clamp-2 h-10 text-sm break-words text-secondary">
            {actionCardPreviewText(message.card) ||
              (message.body
                ? messagePlainText({ body: message.body, mentions: message.mentions })
                : message.forwarded?.[0]
                  ? m.message_forward_preview({ text: message.forwarded[0].sourceBody })
                  : (attachmentName ?? ""))}
          </p>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.conversation_message_actions()} onAction={handleAction}>
            <Dropdown.Item
              id="copy-link"
              icon={Link01}
              label={m.conversation_saved_copy_link()}
              selectionIndicator="none"
            />
            <Dropdown.Item
              id="copy-markdown"
              icon={Copy01}
              label={m.conversation_copy_as_markdown()}
              selectionIndicator="none"
              isDisabled={!message.body}
            />
            <Dropdown.Separator />
            <Dropdown.Item
              id="remove"
              icon={BookmarkCheck}
              label={m.conversation_unsave()}
              selectionIndicator="none"
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ButtonUtility
        icon={BookmarkCheck}
        size="xs"
        color="tertiary"
        tooltip={m.conversation_unsave()}
        aria-label={m.conversation_unsave()}
        onClick={remove}
        className="shrink-0 any-pointer-coarse:-m-2 any-pointer-coarse:size-11"
      />
    </li>
  );
}
