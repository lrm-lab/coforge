import { Fragment, useEffect, useMemo, useState } from "react";
import { useHydrated } from "@tanstack/react-router";
import {
  Edit02,
  Keyboard01,
  Plus,
  RefreshCcw01,
  SearchLg,
  SearchMd,
  Trash01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { SettingsCard, SettingsGroup, SettingsPage } from "#src/components/settings-layout";
import { EmptyState } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { recordHotkeyFromEvent, type ConfigurableShortcutId } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import {
  CONFIGURABLE_SHORTCUT_GROUPS,
  CONFIGURABLE_SHORTCUT_META,
  FIXED_SHORTCUT_ROWS,
  filterFixedShortcuts,
  filterShortcuts,
} from "./keyboard-shortcuts";
import { useOpenKeyboardShortcuts } from "./keyboard-shortcuts-host";
import {
  addShortcutBinding,
  clearShortcutBindings,
  hasCustomShortcuts,
  isShortcutCustomized,
  MAX_SHORTCUT_ALIASES,
  replaceShortcutBinding,
  resetAllShortcutBindings,
  resetShortcutBinding,
  setRecordingShortcut,
  useAllShortcutBindings,
  useShortcutOverrides,
  validateShortcutCandidate,
  type ShortcutValidationResult,
} from "./shortcut-bindings";
import { ShortcutKeycapGroup, ShortcutKeycaps } from "./shortcut-keycaps";

type RecordingTarget =
  | { id: ConfigurableShortcutId; mode: "replace"; index: number }
  | { id: ConfigurableShortcutId; mode: "add" };

function validationMessage(result: Extract<ShortcutValidationResult, { ok: false }>): string {
  switch (result.reason) {
    case "reserved":
      return m.shortcuts_error_reserved();
    case "requires-modifier":
      return m.shortcuts_error_requires_modifier();
    case "duplicate":
      return m.shortcuts_error_duplicate();
    case "conflict":
      return m.shortcuts_error_conflict({
        action: result.conflictId ? CONFIGURABLE_SHORTCUT_META[result.conflictId].label() : "",
      });
  }
}

export function ShortcutsSettings() {
  const openKeymap = useOpenKeyboardShortcuts();
  const overrides = useShortcutOverrides();
  const bindings = useAllShortcutBindings();
  const hydrated = useHydrated();
  const apple = hydrated && isApplePlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingTarget | null>(null);
  const [rowError, setRowError] = useState<{
    id: ConfigurableShortcutId;
    message: string;
  } | null>(null);

  const hasCustom = hasCustomShortcuts(overrides);
  const openKeymapPrimary = bindings.shortcuts[0];

  const filteredGroups = useMemo(
    () => filterShortcuts(query, CONFIGURABLE_SHORTCUT_GROUPS, bindings, apple),
    [query, bindings, apple],
  );
  const filteredFixed = useMemo(
    () => filterFixedShortcuts(query, FIXED_SHORTCUT_ROWS, apple),
    [query, apple],
  );

  useEffect(() => {
    setRecordingShortcut(recording !== null);
    return () => setRecordingShortcut(false);
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;

      if (event.key === "Escape") {
        setRecording(null);
        return;
      }

      const candidate = recordHotkeyFromEvent(event, apple);
      if (!candidate) return;

      const replacingIndex = recording.mode === "replace" ? recording.index : undefined;
      const verdict = validateShortcutCandidate(
        recording.id,
        candidate,
        bindings,
        apple,
        replacingIndex,
      );
      if (!verdict.ok) {
        setRowError({ id: recording.id, message: validationMessage(verdict) });
        setRecording(null);
        return;
      }

      if (recording.mode === "replace") {
        replaceShortcutBinding(recording.id, recording.index, candidate);
      } else {
        addShortcutBinding(recording.id, candidate);
      }
      setRowError(null);
      setRecording(null);
    };

    const onBlur = () => setRecording(null);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording, bindings, apple]);

  function startRecording(target: RecordingTarget) {
    setRowError(null);
    setRecording((current) =>
      current &&
      current.id === target.id &&
      current.mode === target.mode &&
      (current.mode === "add" || (target.mode === "replace" && current.index === target.index))
        ? null
        : target,
    );
  }

  const noResults = filteredGroups.length === 0 && filteredFixed.length === 0;

  return (
    <SettingsPage>
      <div className="space-y-4">
        <p className="text-sm text-tertiary">{m.shortcuts_saved_on_device()}</p>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            type="button"
            color="secondary"
            size="sm"
            iconLeading={Keyboard01}
            onPress={() => {
              setRecording(null);
              openKeymap();
            }}
          >
            <span className="inline-flex items-center gap-2">
              <span>{m.shortcuts_show_all()}</span>
              {openKeymapPrimary && (
                <ShortcutKeycapGroup hotkey={openKeymapPrimary} apple={apple} />
              )}
            </span>
          </Button>
          <Button
            type="button"
            color="secondary"
            size="sm"
            iconLeading={RefreshCcw01}
            isDisabled={!hasCustom}
            onPress={() => {
              setRecording(null);
              setRowError(null);
              resetAllShortcutBindings();
            }}
          >
            {m.shortcuts_reset_all()}
          </Button>
          <div className="min-w-[14rem] flex-1 sm:max-w-xs">
            <Input
              aria-label={m.shortcuts_filter_placeholder()}
              placeholder={m.shortcuts_filter_placeholder()}
              icon={SearchMd}
              size="sm"
              value={query}
              onChange={setQuery}
            />
          </div>
        </div>
      </div>

      {noResults ? (
        <EmptyState
          size="card"
          live="polite"
          picture={<EmptyIcon icon={SearchLg} size="card" />}
          title={
            query.trim()
              ? m.empty_shortcuts_no_match_query({ query: query.trim() })
              : m.shortcuts_filter_empty()
          }
          primaryAction={
            <Button size="sm" color="tertiary" onPress={() => setQuery("")}>
              {m.empty_shortcuts_clear_filter()}
            </Button>
          }
        />
      ) : (
        <>
          {filteredGroups.map((group) => (
            <SettingsGroup key={group.id} icon={Keyboard01} label={group.title()}>
              <SettingsCard>
                <div className="-my-3 divide-y divide-secondary">
                  {group.items.map((id) => {
                    const meta = CONFIGURABLE_SHORTCUT_META[id];
                    const keys = bindings[id];
                    const extraKeys = meta.extraKeys ?? [];
                    const customized = isShortcutCustomized(id, overrides);
                    const isRowRecording = recording?.id === id;
                    const error = rowError?.id === id ? rowError.message : null;
                    const canAdd = keys.length < MAX_SHORTCUT_ALIASES;

                    return (
                      <div key={id} data-shortcut-row={id} className="space-y-1.5 py-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 text-sm font-medium text-primary">
                              {meta.label()}
                            </span>
                            {customized && (
                              <span className="shrink-0 rounded-full bg-tertiary px-2 py-0.5 text-xs font-medium text-tertiary">
                                {m.shortcuts_custom_badge()}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                            {isRowRecording ? (
                              <Button
                                type="button"
                                color="secondary"
                                size="sm"
                                onPress={() => setRecording(null)}
                                className="gap-1.5 bg-secondary px-2.5 text-xs ring-2 ring-focus-ring ring-inset"
                              >
                                <span className="font-medium text-primary">
                                  {m.shortcuts_recording_prompt()}
                                </span>
                                <span className="font-normal text-quaternary">
                                  {m.shortcuts_recording_cancel()}
                                </span>
                              </Button>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1">
                                {keys.length === 0 ? (
                                  <Button
                                    type="button"
                                    color="tertiary"
                                    size="sm"
                                    onPress={() =>
                                      startRecording({ id, mode: "replace", index: 0 })
                                    }
                                    className="px-2 text-xs font-normal text-quaternary"
                                  >
                                    {m.shortcuts_unassigned()}
                                  </Button>
                                ) : (
                                  keys.map((hotkey, index) => (
                                    <Fragment key={hotkey}>
                                      {index > 0 && (
                                        <span className="px-0.5 text-xs text-quaternary">
                                          {m.shortcuts_or()}
                                        </span>
                                      )}
                                      <Button
                                        type="button"
                                        color="tertiary"
                                        size="sm"
                                        onPress={() =>
                                          startRecording({ id, mode: "replace", index })
                                        }
                                        className="px-1.5"
                                        aria-label={`${meta.label()}: ${m.shortcuts_edit_action()}`}
                                      >
                                        <ShortcutKeycapGroup hotkey={hotkey} apple={apple} />
                                      </Button>
                                    </Fragment>
                                  ))
                                )}
                                {extraKeys.map((extra) => (
                                  <Fragment key={extra}>
                                    <span className="px-0.5 text-xs text-quaternary">
                                      {m.shortcuts_or()}
                                    </span>
                                    <ShortcutKeycapGroup hotkey={extra} apple={apple} />
                                  </Fragment>
                                ))}
                              </div>
                            )}

                            <div className="flex items-center gap-0.5 pl-1">
                              <ButtonUtility
                                size="xs"
                                color="tertiary"
                                icon={Edit02}
                                tooltip={m.shortcuts_edit_action()}
                                onClick={() => startRecording({ id, mode: "replace", index: 0 })}
                              />
                              <ButtonUtility
                                size="xs"
                                color="tertiary"
                                icon={Plus}
                                tooltip={m.shortcuts_add_action()}
                                isDisabled={!canAdd}
                                onClick={() => startRecording({ id, mode: "add" })}
                              />
                              <ButtonUtility
                                size="xs"
                                color="tertiary"
                                icon={Trash01}
                                tooltip={m.shortcuts_clear_action()}
                                isDisabled={keys.length === 0}
                                onClick={() => {
                                  setRecording(null);
                                  setRowError(null);
                                  clearShortcutBindings(id);
                                }}
                              />
                              {customized && (
                                <ButtonUtility
                                  size="xs"
                                  color="tertiary"
                                  icon={RefreshCcw01}
                                  tooltip={m.shortcuts_reset_one()}
                                  onClick={() => {
                                    setRecording(null);
                                    setRowError(null);
                                    resetShortcutBinding(id);
                                  }}
                                />
                              )}
                            </div>
                          </div>
                        </div>

                        {error && (
                          <p role="alert" className="text-xs text-error-primary">
                            {error}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </SettingsCard>
            </SettingsGroup>
          ))}

          {filteredFixed.length > 0 && (
            <section aria-label={m.shortcuts_fixed_title()} className="space-y-3">
              <div>
                <h2 className="text-xs font-semibold text-tertiary">{m.shortcuts_fixed_title()}</h2>
                <p className="mt-1 text-xs text-quaternary">{m.shortcuts_fixed_description()}</p>
              </div>
              <div className="rounded-xl border border-secondary bg-secondary px-5 py-3">
                <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                  {filteredFixed.map((row) => (
                    <li
                      key={row.label()}
                      className="flex min-h-8 items-center justify-between gap-3 py-1"
                    >
                      <span className="min-w-0 text-sm text-tertiary">{row.label()}</span>
                      <ShortcutKeycaps hotkeys={row.keys} apple={apple} />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </>
      )}
    </SettingsPage>
  );
}
