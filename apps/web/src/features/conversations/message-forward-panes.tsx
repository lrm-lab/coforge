import { useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ChevronDown, SearchLg } from "@untitledui/icons";

import { Input } from "#src/components/base/input/input";
import { Face } from "#src/features/pickers/entity-picker";
import { PickerListRow } from "#src/features/pickers/picker-list";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ComposerField } from "./composer-field";
import { COMPOSER_BOX_CLASS, COMPOSER_FOCUS_CLASS } from "./composer-frame";
import {
  FORWARD_DESTINATIONS_MAX,
  type ForwardFailureCode,
  type ForwardTarget,
} from "./message-forward";
import {
  canSelectTarget,
  forwardTargetKey,
  forwardTargetLabel,
  isUnjoinedChannel,
} from "./message-forward-model";
import { useReferenceCompletion } from "./use-reference-completion";

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
  // One line a row, a checkbox at its end, as Discord's forward list (Frank, 11-10,
  // design B): the face, the name, and one faint word: a failure, "not joined", or "Agent" (its long
  // `@handle` and description made rows of different heights). The accessible name keeps the
  // handle, which tells apart two Agents of one name.
  const addon = failure
    ? failureLabel(failure)
    : isUnjoinedChannel(target)
      ? m.message_forward_not_joined()
      : target.kind === "agent"
        ? m.message_forward_target_agent()
        : undefined;
  return (
    <PickerListRow
      label={target.name}
      aria-label={
        target.kind === "agent"
          ? `${forwardTargetLabel(target)} @${target.handle}`
          : forwardTargetLabel(target)
      }
      leading={
        target.kind === "channel" ? (
          <Face face={{ kind: "channel", visibility: target.visibility }} />
        ) : (
          <Face face={{ kind: "identity", name: target.name, src: target.avatarUrl }} />
        )
      }
      addon={addon}
      addonError={Boolean(failure)}
      isSelected={selected}
      isDisabled={!selectable}
      onChange={(on) => onToggle(target, on)}
    />
  );
}

/** The picked targets first, then the search's others: what is picked stays in view (and can be
 * unticked) whatever the search shows, so no separate chips are needed. */
export function pinnedTargets(
  selected: ReadonlyMap<string, ForwardTarget>,
  found: readonly ForwardTarget[],
): ForwardTarget[] {
  return [
    ...selected.values(),
    ...found.filter((target) => !selected.has(forwardTargetKey(target))),
  ];
}

/** Search on top, the people, Agents and channels under it, one line each. */
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
  const rows = targets === null ? [...selected.values()] : pinnedTargets(selected, targets);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="px-4 sm:px-6">
        <Input
          size="md"
          aria-label={m.message_forward_search()}
          placeholder={m.message_forward_search()}
          icon={SearchLg}
          value={query}
          onChange={onQueryChange}
        />
      </div>
      {selected.size >= FORWARD_DESTINATIONS_MAX && (
        // Why the rest have greyed out.
        <p role="status" className="px-4 text-sm text-tertiary sm:px-6">
          {m.message_forward_limit({ max: FORWARD_DESTINATIONS_MAX })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 sm:px-4">
        {error ? (
          <p role="alert" className="py-6 text-center text-sm text-error-primary">
            {m.message_forward_search_failed()}
          </p>
        ) : rows.length === 0 && targets !== null ? (
          <p className="py-6 text-center text-sm text-tertiary">{m.message_forward_no_matches()}</p>
        ) : (
          <ul className="flex flex-col py-1">
            {rows.map((target) => {
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

/** What arrives, as one line (`summary`) that opens into the whole of it (`preview`): the list is
 * the dialog's work, so the content stays out of its way until asked for. */
function WhatArrives({ summary, preview }: { summary: ReactNode; preview: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-secondary">
      <AriaButton
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{summary}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-quaternary transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </AriaButton>
      {open && (
        // A short window keeps room for the list above.
        <div className="max-h-[min(14rem,25dvh)] overflow-y-auto border-t border-secondary p-3">
          {preview}
        </div>
      )}
    </div>
  );
}

/** Under the list: what arrives, then the note in the same composer as under the messages (Frank,
 * 11-10), whose send button is named for what it does: how many it goes to, or that sending joins a
 * channel first. Enter sends, as in a conversation. */
export function ForwardComposer({
  summary,
  preview,
  canSend,
  note,
  onNoteChange,
  noteMaxLength,
  placeholder,
  sendLabel,
  sending,
  onSend,
  notice,
  joinNotice,
}: {
  summary: ReactNode;
  preview: ReactNode;
  canSend: boolean;
  note: string;
  onNoteChange: (note: string) => void;
  noteMaxLength: number;
  placeholder: string;
  sendLabel: string;
  sending: boolean;
  onSend: () => void;
  /** What the last press of send left to say: a failure, with its retry. */
  notice: ReactNode;
  /** That sending joins channels first, in words: the send is an icon a phone cannot hover. */
  joinNotice?: string;
}) {
  // No `@` or `#` lists: a note is read where it lands, so it names no one here.
  const completion = useReferenceCompletion({
    mentionables: undefined,
    value: note,
    onChange: onNoteChange,
  });
  const send = () => {
    if (canSend && !sending) onSend();
  };
  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-secondary px-4 pt-4 pb-[max(1rem,var(--spacing-safe-bottom))] sm:px-6 sm:pb-6">
      <WhatArrives summary={summary} preview={preview} />
      {notice}
      {joinNotice && <p className="-mb-1 px-1 text-sm text-tertiary">{joinNotice}</p>}
      {/* A form, as under the messages: the send button submits it. */}
      <form
        className={cn(COMPOSER_BOX_CLASS, COMPOSER_FOCUS_CLASS)}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <ComposerField
          completion={completion}
          value={note}
          onValueChange={onNoteChange}
          label={m.message_forward_note_label()}
          placeholder={placeholder}
          onSubmit={send}
          sendDisabled={!canSend || sending}
          isReadOnly={sending}
          maxLength={noteMaxLength}
          sendLabel={sendLabel}
        />
      </form>
    </div>
  );
}
