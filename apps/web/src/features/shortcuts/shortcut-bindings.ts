import { useMemo, useSyncExternalStore } from "react";

import { createDevicePreference } from "#src/features/settings/device-preference";
import {
  CONFIGURABLE_SHORTCUT_IDS,
  DEFAULT_HOTKEY_BINDINGS,
  hasPrimaryModifier,
  hotkeysEqual,
  type ConfigurableShortcutId,
} from "#src/lib/hotkeys";

export const SHORTCUTS_STORAGE_KEY = "coforge-shortcuts";
export const MAX_SHORTCUT_ALIASES = 4;

export type ShortcutScope = "global" | "composer" | "activity" | "preview";
export type ShortcutOverrides = Partial<Record<ConfigurableShortcutId, readonly string[]>>;
export type ShortcutBindingMap = Record<ConfigurableShortcutId, readonly string[]>;

export const SHORTCUT_SCOPES: Record<ConfigurableShortcutId, ShortcutScope> = {
  shortcuts: "global",
  search: "global",
  sidebar: "global",
  sendAsTask: "composer",
  activityNext: "activity",
  activityPrev: "activity",
  activityDone: "activity",
  activityRead: "activity",
  previewFind: "preview",
  draftUndo: "preview",
  draftRedo: "preview",
};

const VALID_IDS = new Set<string>(CONFIGURABLE_SHORTCUT_IDS);

const RESERVED_BARE_KEYS = new Set([
  "Escape",
  "Enter",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sanitizeBindings(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || result.includes(trimmed)) continue;
    result.push(trimmed);
    if (result.length >= MAX_SHORTCUT_ALIASES) break;
  }
  return result;
}

export function parseStoredShortcutOverrides(stored: string | null): ShortcutOverrides {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: ShortcutOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!VALID_IDS.has(key)) continue;
      const id = key as ConfigurableShortcutId;
      const cleaned = sanitizeBindings(value);
      if (cleaned && !arraysEqual(cleaned, DEFAULT_HOTKEY_BINDINGS[id])) overrides[id] = cleaned;
    }
    return overrides;
  } catch {
    return {};
  }
}

const shortcutOverridesPreference = createDevicePreference<ShortcutOverrides>({
  key: SHORTCUTS_STORAGE_KEY,
  fallback: {},
  parse: parseStoredShortcutOverrides,
  serialize: (overrides) => JSON.stringify(overrides),
});

let recordingShortcut = false;
const recordingListeners = new Set<() => void>();

export function setRecordingShortcut(active: boolean) {
  if (recordingShortcut === active) return;
  recordingShortcut = active;
  for (const listener of recordingListeners) listener();
}

export function isRecordingShortcut(): boolean {
  return recordingShortcut;
}

function subscribeRecording(listener: () => void) {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

function getRecordingSnapshot(): boolean {
  return recordingShortcut;
}

function getRecordingServerSnapshot(): boolean {
  return false;
}

export function useIsRecordingShortcut(): boolean {
  return useSyncExternalStore(subscribeRecording, getRecordingSnapshot, getRecordingServerSnapshot);
}

function resolveAllBindings(overrides: ShortcutOverrides): ShortcutBindingMap {
  const map = {} as ShortcutBindingMap;
  for (const id of CONFIGURABLE_SHORTCUT_IDS)
    map[id] = overrides[id] ?? DEFAULT_HOTKEY_BINDINGS[id];
  return map;
}

export function readShortcutOverrides(): ShortcutOverrides {
  return shortcutOverridesPreference.read();
}

export function readShortcutBindings(id: ConfigurableShortcutId): readonly string[] {
  return shortcutOverridesPreference.read()[id] ?? DEFAULT_HOTKEY_BINDINGS[id];
}

export function readAllShortcutBindings(): ShortcutBindingMap {
  return resolveAllBindings(shortcutOverridesPreference.read());
}

export function useShortcutOverrides(): ShortcutOverrides {
  return shortcutOverridesPreference.useValue()[0];
}

export function useShortcutBindings(id: ConfigurableShortcutId): readonly string[] {
  const overrides = useShortcutOverrides();
  return overrides[id] ?? DEFAULT_HOTKEY_BINDINGS[id];
}

export function useAllShortcutBindings(): ShortcutBindingMap {
  const overrides = useShortcutOverrides();
  return useMemo(() => resolveAllBindings(overrides), [overrides]);
}

export function isShortcutCustomized(
  id: ConfigurableShortcutId,
  overrides: ShortcutOverrides = shortcutOverridesPreference.read(),
): boolean {
  return overrides[id] !== undefined;
}

export function hasCustomShortcuts(
  overrides: ShortcutOverrides = shortcutOverridesPreference.read(),
): boolean {
  return Object.keys(overrides).length > 0;
}

export function setShortcutBindings(id: ConfigurableShortcutId, nextKeys: readonly string[]) {
  const current = shortcutOverridesPreference.read();
  const cleaned = sanitizeBindings([...nextKeys]) ?? [];
  const next: ShortcutOverrides = { ...current };
  if (arraysEqual(cleaned, DEFAULT_HOTKEY_BINDINGS[id])) delete next[id];
  else next[id] = cleaned;
  shortcutOverridesPreference.write(next);
}

export function replaceShortcutBinding(id: ConfigurableShortcutId, index: number, hotkey: string) {
  const existing = [...readShortcutBindings(id)];
  if (existing.length === 0 || index < 0 || index >= existing.length) {
    setShortcutBindings(id, [hotkey]);
    return;
  }
  existing[index] = hotkey;
  setShortcutBindings(id, existing);
}

export function addShortcutBinding(id: ConfigurableShortcutId, hotkey: string) {
  const existing = readShortcutBindings(id);
  if (existing.length >= MAX_SHORTCUT_ALIASES) return;
  setShortcutBindings(id, [...existing, hotkey]);
}

export function removeShortcutBinding(id: ConfigurableShortcutId, index: number) {
  const existing = readShortcutBindings(id);
  setShortcutBindings(
    id,
    existing.filter((_, i) => i !== index),
  );
}

export function clearShortcutBindings(id: ConfigurableShortcutId) {
  setShortcutBindings(id, []);
}

export function resetShortcutBinding(id: ConfigurableShortcutId) {
  const current = shortcutOverridesPreference.read();
  if (!(id in current)) return;
  const next: ShortcutOverrides = { ...current };
  delete next[id];
  shortcutOverridesPreference.write(next);
}

export function resetAllShortcutBindings() {
  shortcutOverridesPreference.write({});
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || a === "global" || b === "global";
}

export type ShortcutValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "reserved" | "requires-modifier" | "duplicate" | "conflict";
      conflictId?: ConfigurableShortcutId;
    };

export function validateShortcutCandidate(
  id: ConfigurableShortcutId,
  candidate: string,
  bindings: ShortcutBindingMap,
  apple: boolean,
  replacingIndex?: number,
): ShortcutValidationResult {
  if (!hasPrimaryModifier(candidate) && RESERVED_BARE_KEYS.has(candidate)) {
    return { ok: false, reason: "reserved" };
  }

  if (
    SHORTCUT_SCOPES[id] === "composer" &&
    !hasPrimaryModifier(candidate) &&
    !FUNCTION_KEY.test(candidate)
  ) {
    return { ok: false, reason: "requires-modifier" };
  }

  const ownKeys = bindings[id];
  const isDuplicate = ownKeys.some(
    (existing, index) => index !== replacingIndex && hotkeysEqual(existing, candidate, apple),
  );
  if (isDuplicate) return { ok: false, reason: "duplicate" };

  const scope = SHORTCUT_SCOPES[id];
  for (const otherId of CONFIGURABLE_SHORTCUT_IDS) {
    if (otherId === id || !scopesOverlap(scope, SHORTCUT_SCOPES[otherId])) continue;
    if (bindings[otherId].some((existing) => hotkeysEqual(existing, candidate, apple))) {
      return { ok: false, reason: "conflict", conflictId: otherId };
    }
  }

  return { ok: true };
}
