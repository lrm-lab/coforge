import { DEFAULT_HOTKEY_BINDINGS, hotkeyMatchesEvent } from "#src/lib/hotkeys";
import { m } from "#src/paraglide/messages";

export const IME_ENTER_GUARD_MS = 50;

export type EnterKeyLikeEvent = {
  key: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing: boolean;
};

export type EnterSendOptions = {
  newlineModifier?: "shift" | "ctrl";
};

function isConfirmingIme(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
): boolean {
  if (event.isComposing) return true;
  const { lastCompositionEndAt, now } = composition;
  return lastCompositionEndAt !== null && now - lastCompositionEndAt < IME_ENTER_GUARD_MS;
}

export function shouldSendOnEnter(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
  options?: EnterSendOptions,
): boolean {
  if (event.key !== "Enter") return false;
  const newlineModifier = options?.newlineModifier ?? "shift";
  if (newlineModifier === "shift" && event.shiftKey) return false;
  if (newlineModifier === "ctrl" && (event.ctrlKey || event.metaKey)) return false;
  return !isConfirmingIme(event, composition);
}

export function shouldSendAsTaskOnEnter(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
  bindings: readonly string[] = DEFAULT_HOTKEY_BINDINGS.sendAsTask,
  apple?: boolean,
): boolean {
  if (isConfirmingIme(event, composition)) return false;
  return bindings.some((hotkey) =>
    apple !== undefined
      ? hotkeyMatchesEvent(hotkey, event, apple)
      : hotkeyMatchesEvent(hotkey, event, true) || hotkeyMatchesEvent(hotkey, event, false),
  );
}

/** The empty composer's placeholder: the thread's, or "Message #channel" / "Message …". */
export function composerPlaceholder(inThread: boolean, target?: string): string {
  if (inThread) return m.conversation_thread_message_placeholder();
  return target
    ? m.conversation_message_placeholder_to({ target })
    : m.conversation_message_placeholder();
}

/**
 * Whether the composer stacks (the text across the top, the attachments under it, the buttons on
 * a bar below) whatever the text's width: for a newline or any attachment. Otherwise it stacks
 * only when the text or the placeholder would not fit the one-line text column, which the composer
 * measures there, never at the current width: stacking widens the text, and measuring that would
 * collapse it again.
 */
export function forcesStackedLayout(body: string, attachmentCount: number): boolean {
  return body.includes("\n") || attachmentCount > 0;
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
