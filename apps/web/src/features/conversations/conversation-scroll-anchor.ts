export const TASK_TITLE_SCROLL_EVENT = "task-scroll-to-title";

export interface ScrollAnchor {
  lead?: boolean;
  rowId?: string;
  offset: number;
  height: number;
  top: number;
}

export function scrollAnchorOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-scroll-anchor]") ?? row;
}

export function captureScrollAnchor(history: HTMLDivElement): ScrollAnchor {
  const containerTop = history.getBoundingClientRect().top;
  const lead = history.querySelector<HTMLElement>("[data-scroll-lead]")?.getBoundingClientRect();
  if (lead && lead.bottom > containerTop)
    return {
      lead: true,
      offset: lead.top - containerTop,
      height: history.scrollHeight,
      top: history.scrollTop,
    };
  let rowId: string | undefined;
  let offset = 0;
  for (const row of history.querySelectorAll<HTMLElement>("li[data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= containerTop) continue;
    rowId = row.dataset.messageId;
    offset = scrollAnchorOf(row).getBoundingClientRect().top - containerTop;
    break;
  }
  return { rowId, offset, height: history.scrollHeight, top: history.scrollTop };
}

export function restoreScrollAnchor(
  history: HTMLDivElement | null,
  anchor: ScrollAnchor | undefined,
) {
  if (!anchor || !history) return;
  const lead = history.querySelector<HTMLElement>("[data-scroll-lead]");
  if (lead && history.scrollTop === 0) return;
  if (anchor.lead && lead) {
    const delta =
      lead.getBoundingClientRect().top - (history.getBoundingClientRect().top + anchor.offset);
    if (delta) history.scrollTop += delta;
    return;
  }
  if (anchor.rowId && restoreAnchoredRow(history, anchor.rowId, anchor.offset)) return;
  history.scrollTop = anchor.top + (history.scrollHeight - anchor.height);
}

export function restoreAnchoredRow(history: HTMLDivElement, rowId: string, offset: number) {
  const id = CSS.escape(rowId);
  const row =
    history.querySelector<HTMLElement>(`li[data-message-id="${id}"]:not([data-system-group])`) ??
    history.querySelector<HTMLElement>(`li[data-system-group-members~="${id}"]`);
  if (!row) return false;
  const containerTop = history.getBoundingClientRect().top;
  const delta = scrollAnchorOf(row).getBoundingClientRect().top - (containerTop + offset);
  if (delta) history.scrollTop += delta;
  return true;
}

export const ROW_TOP_GAP_PX = 12;

export function scrollTwice(scroll: () => void) {
  scroll();
  requestAnimationFrame(scroll);
}

export function scrollToMessageRow(messageId: string, landed: (row: Element) => void) {
  scrollTwice(() => {
    const row = document.getElementById(`message-${messageId}`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    landed(row);
  });
}
