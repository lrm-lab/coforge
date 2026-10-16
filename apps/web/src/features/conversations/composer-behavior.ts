/**
 * Pure decision functions for the message composer's Enter-to-send and
 * paste-to-upload behaviour, kept free of React and DOM types so they can be
 * unit tested with plain objects.
 *
 * React Aria's `useKeyboard` (https://react-aria.adobe.com/useKeyboard) is a
 * thin passthrough over native keyboard events with no IME awareness, and
 * `useClipboard` (https://react-aria.adobe.com/useClipboard) unconditionally
 * calls `preventDefault()` on every paste once an `onPaste` handler is given
 * (see its `dnd/useClipboard` implementation), which would also swallow
 * plain-text pastes into this textarea. Neither hook fits a live-editing
 * native `<textarea>`, so the composer wires the standard
 * `onKeyDown`/`onCompositionStart`/`onCompositionEnd`/`onPaste` DOM props
 * directly, same as its existing `onKeyDown`/`onChange` handlers, and the
 * decisions below are the pure logic behind them.
 */

/** How long after `compositionend` an Enter keydown is still treated as part of the same IME confirmation (Safari fires it after compositionend with `isComposing` already false). */
export const IME_ENTER_GUARD_MS = 50;

export type EnterKeyLikeEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** `event.nativeEvent.isComposing` OR'd with the composer's own compositionstart/compositionend tracking. */
  isComposing: boolean;
  /** `event.keyCode`; Safari/Chrome fire keydown with 229 while a composition is in progress. */
  keyCode: number;
};

export type EnterSendOptions = {
  /**
   * Modifier that keeps Enter as a newline instead of send.
   * Channel composer: Shift+Enter. Records side chat: Ctrl/Cmd+Enter.
   */
  newlineModifier?: "shift" | "ctrl";
};

/**
 * Whether a keydown on the composer textarea should submit the message.
 * Plain Enter sends; the configured newline modifier stays a newline; Enter is
 * ignored entirely while (or immediately after) an IME composition is being
 * confirmed.
 */
export function shouldSendOnEnter(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
  options?: EnterSendOptions,
): boolean {
  if (event.key !== "Enter") return false;
  const newlineModifier = options?.newlineModifier ?? "shift";
  if (newlineModifier === "shift" && event.shiftKey) return false;
  if (newlineModifier === "ctrl" && (event.ctrlKey || event.metaKey)) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const { lastCompositionEndAt, now } = composition;
  if (lastCompositionEndAt !== null && now - lastCompositionEndAt < IME_ENTER_GUARD_MS)
    return false;
  return true;
}

/**
 * Whether a keydown on the composer textarea is "send as task": Cmd/Ctrl+Shift+Enter, as Raft's
 * composer binds it. It sends as a task whether or not the composer's "As task" box is ticked, and
 * stays ignored while (or just after) an IME composition is being confirmed, as Enter does.
 */
export function shouldSendAsTaskOnEnter(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
): boolean {
  if (event.key !== "Enter" || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return false;
  return shouldSendOnEnter({ ...event, shiftKey: false }, composition);
}

export type ClipboardDataLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
};

/**
 * The files carried by a paste event, preferring `clipboardData.files` and
 * falling back to scanning `items` for `kind === "file"` entries (some
 * browsers only populate `items` for pasted screenshots).
 */
export function filesFromPaste(clipboardData: ClipboardDataLike | null | undefined): File[] {
  if (!clipboardData) return [];
  const files = clipboardData.files ? Array.from(clipboardData.files) : [];
  if (files.length > 0) return files;
  if (!clipboardData.items) return [];
  const fallback: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fallback.push(file);
  }
  return fallback;
}

/**
 * Whether a drag carries at least one native file (e.g. dragged from Finder or Explorer),
 * checked against `dataTransfer.types` during `dragenter`/`dragover`, before any file is
 * actually readable. A plain text or URL drag (e.g. a text selection or a link) never
 * includes this type, so the composer's drag handlers can leave those alone and let the
 * browser's own drop-to-insert behaviour reach the textarea underneath.
 */
export function dragCarriesFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/**
 * The files dropped onto the composer, in order. Drag events carry data through the same
 * `DataTransfer` shape as paste's `ClipboardData`, so this reuses `filesFromPaste`: a drop of
 * several files attaches them all, as the file picker and paste do.
 */
export function filesFromDrop(dataTransfer: ClipboardDataLike | null | undefined): File[] {
  return filesFromPaste(dataTransfer);
}

/**
 * A fresh id for composer-local state (pending attachments, outbox messages, idempotency keys).
 * `crypto.randomUUID` exists only in secure contexts (`https://` or `localhost`); in a plain
 * `http://` origin it throws or is missing, which used to kill the entire attachment flow
 * before any card could render — a silently dead send button. The fallback keeps local
 * uniqueness without depending on secure-context globals; only local state ever consumes it.
 */
export function localId(now: () => number = Date.now): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch {
    // Secure-context violation or absence; the fallback below still produces a unique string.
  }
  return `local-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
