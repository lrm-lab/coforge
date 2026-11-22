import { useRef, type Ref } from "react";
import { useHydrated } from "@tanstack/react-router";
import { RefreshCcw01 as Refresh, Trash01 as Trash } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { KeyPointPromptHistoryEntry, KeyPointPromptState } from "./records-content";

export function KeyPointPromptEditor({
  prompt,
  text,
  busy,
  textareaRef,
  onChange,
  onFocus,
  onBlur,
  onDeleteHistory,
}: {
  prompt: KeyPointPromptState;
  text: string;
  busy?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onDeleteHistory?: (entry: KeyPointPromptHistoryEntry) => Promise<void>;
}) {
  const historyRef = useRef<HTMLElement>(null);
  const hydrated = useHydrated();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const locale = getLocale();
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-primary">
          {m.records_key_points_prompt_label()}
        </h2>
        <TextArea
          textAreaRef={textareaRef}
          aria-label={m.records_key_points_prompt_label()}
          value={text}
          isReadOnly={busy}
          maxLength={20_000}
          rows={10}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
          onTextAreaCompositionEnd={(event) => onChange(event.currentTarget.value)}
          placeholder={m.records_key_points_prompt_placeholder()}
          size="sm"
          textAreaClassName="resize-y read-only:opacity-80"
        />
      </section>

      <section ref={historyRef} tabIndex={-1} className="space-y-3 outline-hidden">
        <h2 className="text-sm font-semibold text-primary">
          {m.records_key_points_prompt_history()}
        </h2>
        {prompt.history.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_key_points_prompt_history_empty()}</p>
        ) : (
          <ul className="space-y-4">
            {prompt.history.map((entry, historyIndex) => (
              <li key={`${entry.updatedAt}-${historyIndex}`} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <time
                    dateTime={new Date(entry.updatedAt).toISOString()}
                    className="text-xs text-tertiary tabular-nums"
                  >
                    {hydrated
                      ? m.records_key_points_prompt_updated({
                          time: formatDateForDisplay(entry.updatedAt, timeZone, locale, timeFormat),
                        })
                      : "\u00A0"}
                  </time>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      color="link-gray"
                      iconLeading={Refresh}
                      isDisabled={busy}
                      className="any-pointer-coarse:min-h-11 any-pointer-coarse:px-2"
                      onPress={() => onChange(entry.text)}
                    >
                      {m.records_key_points_prompt_reuse()}
                    </Button>
                    {onDeleteHistory ? (
                      <Popconfirm
                        title={m.records_key_points_prompt_history_delete_confirm_title()}
                        description={m.records_key_points_prompt_history_delete_confirm_body()}
                        confirmLabel={m.records_key_points_prompt_history_delete_action()}
                        pendingLabel={m.records_delete_pending()}
                        errorMessage={m.records_delete_error()}
                        placement="bottom end"
                        fallbackFocus={() => historyRef.current}
                        onConfirm={() => onDeleteHistory(entry)}
                      >
                        <Button
                          type="button"
                          size="sm"
                          color="tertiary-destructive"
                          iconLeading={Trash}
                          isDisabled={busy}
                          className="any-pointer-coarse:min-h-11 any-pointer-coarse:px-2"
                        >
                          {m.records_key_points_prompt_history_delete()}
                        </Button>
                      </Popconfirm>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-xl bg-secondary px-3 py-3 text-sm whitespace-pre-wrap text-secondary">
                  {entry.text}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
