import type { ReactNode } from "react";
import { Checkbox as AriaCheckbox, Tag, TagGroup, TagList } from "react-aria-components";
import { Hash01, SearchLg } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { TagCloseX } from "#src/components/base/tags/base-components/tag-close-x";
import { TextArea } from "#src/components/base/textarea/textarea";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { FORWARD_NOTE_MAX_LENGTH } from "./message-forward";
import type { ForwardFailureCode, ForwardTarget, ForwardedMessageView } from "./message-forward";
import { ForwardedMessageCard } from "./message-forward-card";
import {
  canSelectTarget,
  forwardTargetKey,
  forwardTargetLabel,
  isUnjoinedChannel,
} from "./message-forward-model";
import type { MessageView } from "./message-view";

/** What a destination's failure reads as on its row: a channel to join first, or one that will not
 * take it. */
function failureLabel(code: ForwardFailureCode) {
  return code === "not_joined" ? m.message_forward_not_joined() : m.message_forward_unavailable();
}

function TargetRow({
  target,
  selected,
  selectable,
  failure,
  onToggle,
}: {
  target: ForwardTarget;
  selected: boolean;
  selectable: boolean;
  failure: ForwardFailureCode | undefined;
  onToggle: (target: ForwardTarget, on: boolean) => void;
}) {
  const label = forwardTargetLabel(target);
  const tag = failure
    ? failureLabel(failure)
    : isUnjoinedChannel(target)
      ? m.message_forward_not_joined()
      : undefined;
  return (
    <li>
      <AriaCheckbox
        isSelected={selected}
        isDisabled={!selectable}
        onChange={(on) => onToggle(target, on)}
        aria-label={label}
        className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-primary_hover disabled:cursor-not-allowed"
      >
        {({ isSelected: on, isDisabled, isFocusVisible }) => (
          <>
            <CheckboxBase isSelected={on} isDisabled={isDisabled} isFocusVisible={isFocusVisible} />
            {target.kind === "channel" ? (
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-md bg-tertiary text-fg-quaternary"
              >
                <Hash01 className="size-3.5" />
              </span>
            ) : (
              <IdentityAvatar
                size="xs"
                className="avatar-square"
                alt=""
                src={target.avatarUrl}
                name={target.name}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium text-primary",
                isDisabled && "text-tertiary",
              )}
            >
              {target.kind === "channel" ? target.name : label}
            </span>
            {tag && (
              <span
                className={cn("shrink-0 text-xs", failure ? "text-error-primary" : "text-tertiary")}
              >
                {tag}
              </span>
            )}
          </>
        )}
      </AriaCheckbox>
    </li>
  );
}

/** The left pane: search, and the people, Agents and channels to pick from. */
export function ForwardTargetPane({
  query,
  onQueryChange,
  targets,
  failed,
  error,
  selected,
  onToggle,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  /** Null while the first search is in flight. */
  targets: readonly ForwardTarget[] | null;
  /** Failure per target key after a send, shown on its row. */
  failed: ReadonlyMap<string, ForwardFailureCode>;
  error: boolean;
  selected: ReadonlyMap<string, ForwardTarget>;
  onToggle: (target: ForwardTarget, on: boolean) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      <Input
        size="sm"
        aria-label={m.message_forward_search()}
        placeholder={m.message_forward_search()}
        icon={SearchLg}
        value={query}
        onChange={onQueryChange}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="py-4 text-center text-sm text-error-primary">
            {m.message_forward_search_failed()}
          </p>
        ) : targets?.length === 0 ? (
          <p className="py-4 text-center text-sm text-tertiary">{m.message_forward_no_matches()}</p>
        ) : (
          <ul className="flex flex-col">
            {targets?.map((target) => {
              const key = forwardTargetKey(target);
              const on = selected.has(key);
              return (
                <TargetRow
                  key={key}
                  target={target}
                  selected={on}
                  selectable={canSelectTarget(target, selected.size, on)}
                  failure={failed.get(key)}
                  onToggle={onToggle}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Who the forward goes to, as removable chips: the pick stays in view while the list is filtered
 * or, on a phone, a step behind. */
function Recipients({
  picked,
  onRemove,
}: {
  picked: readonly ForwardTarget[];
  onRemove: (target: ForwardTarget) => void;
}) {
  if (picked.length === 0) return null;
  return (
    <TagGroup
      aria-label={m.message_forward_recipients()}
      onRemove={(keys) => {
        for (const target of picked) if (keys.has(forwardTargetKey(target))) onRemove(target);
      }}
      className="flex items-start gap-2"
    >
      <span aria-hidden="true" className="shrink-0 py-1 text-sm text-tertiary">
        {m.message_forward_to()}
      </span>
      <TagList className="flex min-w-0 flex-wrap items-center gap-1.5">
        {picked.map((target) => (
          <Tag
            key={forwardTargetKey(target)}
            id={forwardTargetKey(target)}
            textValue={forwardTargetLabel(target)}
            className="inline-flex h-7 max-w-[16rem] cursor-default items-center gap-1 rounded-md border border-secondary pr-1.5 pl-2 text-sm text-secondary outline-focus-ring focus-visible:outline-2"
          >
            <span className="truncate">{forwardTargetLabel(target)}</span>
            {/* React Aria names it "<this label> <the chip>". */}
            <TagCloseX size="md" aria-label={m.message_forward_remove_target()} />
          </Tag>
        ))}
      </TagList>
    </TagGroup>
  );
}

/** The right pane: the card as it will arrive, then who it goes to, the optional note, and the
 * send button, which says when sending joins a channel first. ⌘/Ctrl+Enter in the note sends. */
export function ForwardNotePane({
  forwarded,
  attachments,
  picked,
  onRemove,
  note,
  onNoteChange,
  placeholder,
  sendLabel,
  sending,
  onSend,
  notice,
}: {
  forwarded: ForwardedMessageView;
  attachments: MessageView["attachments"];
  picked: readonly ForwardTarget[];
  onRemove: (target: ForwardTarget) => void;
  note: string;
  onNoteChange: (note: string) => void;
  placeholder: string;
  sendLabel: string;
  sending: boolean;
  onSend: () => void;
  /** What the last press of send left to say: a failure, with its retry. */
  notice: ReactNode;
}) {
  const canSend = picked.length > 0 && !sending;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ForwardedMessageCard forwarded={forwarded} attachments={attachments} />
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-secondary p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {notice}
        <Recipients picked={picked} onRemove={onRemove} />
        <TextArea
          size="sm"
          aria-label={m.message_forward_note_label()}
          placeholder={placeholder}
          rows={3}
          maxLength={FORWARD_NOTE_MAX_LENGTH}
          value={note}
          onChange={onNoteChange}
          isDisabled={sending}
          onTextAreaKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) onSend();
          }}
        />
        <div className="flex justify-end">
          <Button
            size="md"
            isDisabled={!canSend}
            isLoading={sending}
            showTextWhileLoading
            onPress={onSend}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
