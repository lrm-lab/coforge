import { browserLocalStorage } from "#src/features/browser-local-storage";
import { m } from "#src/paraglide/messages";

export type ListColumn = {
  key: string;
  property: string;
  defaultWidth: number;
  min: number;
  max: number;
  maxPct: number;
  label: () => string;
};

export const CONVERSATION_LIST_COLUMN: ListColumn = {
  key: "coforge-conversation-list-width",
  property: "--conversation-list-width",
  defaultWidth: 18,
  min: 12.5,
  max: 25,
  maxPct: 40,
  label: m.conversation_list_resize,
};

export const LIST_COLUMN: ListColumn = {
  key: "coforge-list-column-width",
  property: "--list-column-width",
  defaultWidth: 23.75,
  min: 18,
  max: 40,
  maxPct: 50,
  label: m.list_column_resize,
};

export const ATTACHMENT_COMMENTS_COLUMN: ListColumn = {
  key: "coforge-attachment-comments-width",
  property: "--attachment-comments-width",
  defaultWidth: 20,
  min: 17.5,
  max: 35,
  maxPct: 50,
  label: m.attachment_comments_resize,
};

const LEGACY_PX_THRESHOLD = 80;
const LEGACY_BASE_FONT_PX = 16;

export const LIST_COLUMN_CLASS = "lg:w-[min(var(--conversation-list-width,18rem),40%)]";

const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

function bootScript({ key, property, min, max }: ListColumn): string {
  return `var listWidth=localStorage.getItem("${key}");if(listWidth!==null&&${PLAIN_NUMBER}.test(listWidth)){var listRem=+listWidth>${LEGACY_PX_THRESHOLD}?+listWidth/${LEGACY_BASE_FONT_PX}:+listWidth;document.documentElement.style.setProperty("${property}",Math.min(${max},Math.max(${min},listRem))+"rem")}`;
}

export const CONVERSATION_LIST_BOOT =
  bootScript(CONVERSATION_LIST_COLUMN) +
  bootScript(LIST_COLUMN) +
  bootScript(ATTACHMENT_COMMENTS_COLUMN);

export function clampListWidth(column: ListColumn, width: number): number {
  return Math.min(column.max, Math.max(column.min, width));
}

export function parseListWidth(column: ListColumn, raw: string | null): number | undefined {
  if (raw === null || !PLAIN_NUMBER.test(raw)) return undefined;
  const parsed = Number(raw);
  const rem = parsed > LEGACY_PX_THRESHOLD ? parsed / LEGACY_BASE_FONT_PX : parsed;
  return clampListWidth(column, rem);
}

export function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LEGACY_BASE_FONT_PX;
}

export function readStoredListWidth(column: ListColumn): number {
  try {
    return (
      parseListWidth(column, browserLocalStorage()?.getItem(column.key) ?? null) ??
      column.defaultWidth
    );
  } catch {
    return column.defaultWidth;
  }
}

export function applyListWidthProperty(column: ListColumn, widthRem: number): number {
  const rounded = Math.round(clampListWidth(column, widthRem) * 1000) / 1000;
  document.documentElement.style.setProperty(column.property, `${rounded}rem`);
  return rounded;
}

export function writeStoredListWidth(column: ListColumn, widthRem: number): number {
  const rounded = applyListWidthProperty(column, widthRem);
  try {
    browserLocalStorage()?.setItem(column.key, String(rounded));
  } catch {}
  return rounded;
}
