import { useRef, type FormEvent, type KeyboardEvent } from "react";
import { Microphone02 as Microphone, Paperclip, Send01 as Send } from "@untitledui/icons";
import { FIELD_STATES } from "#src/components/base/input/field-states";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { TextArea } from "#src/components/base/textarea/textarea";
import { shouldSendOnEnter } from "#src/features/conversations/composer-behavior";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { SendCountdownBadge } from "./record-side-panel-cards";

export function RecordSideChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  sendLocked,
  countdownUntil,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  sendLocked: boolean;
  countdownUntil?: Date | null;
}) {
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const send = shouldSendOnEnter(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing || isComposingRef.current,
      },
      { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() },
      { newlineModifier: "ctrl" },
    );
    if (!send) return;
    event.preventDefault();
    onSubmit(event as unknown as FormEvent);
  }

  return (
    <form onSubmit={onSubmit} className="border-t border-secondary p-3">
      <div
        className={cx("flex items-end gap-2 p-1.5", FIELD_STATES.frame, FIELD_STATES.frameTyping)}
      >
        <ButtonUtility
          type="button"
          size="sm"
          color="tertiary"
          icon={Paperclip}
          aria-label={m.records_side_chat_attach()}
          isDisabled
        />
        <TextArea
          aria-label={m.records_side_chat_placeholder()}
          value={draft}
          onChange={onDraftChange}
          onTextAreaKeyDown={onComposerKeyDown}
          onTextAreaCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onTextAreaCompositionEnd={() => {
            isComposingRef.current = false;
            lastCompositionEndAtRef.current = Date.now();
          }}
          placeholder={
            sendLocked ? m.records_side_chat_placeholder_busy() : m.records_side_chat_placeholder()
          }
          rows={1}
          textAreaClassName="resize-none border-0 bg-transparent p-1 shadow-none ring-0 focus:ring-0"
          className="min-w-0 flex-1"
        />
        <div className="flex shrink-0 items-center gap-1">
          <SendCountdownBadge until={countdownUntil} />
          <ButtonUtility
            type="button"
            size="sm"
            color="tertiary"
            icon={Microphone}
            aria-label={m.records_side_chat_voice()}
            isDisabled
          />
          <Button
            type="submit"
            size="sm"
            color="primary"
            iconLeading={Send}
            aria-label={m.records_side_chat_send()}
            isDisabled={sendLocked || !draft.trim()}
          />
        </div>
      </div>
    </form>
  );
}
