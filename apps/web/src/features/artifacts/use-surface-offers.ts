import { useEffect, useMemo, useState, type MouseEvent, type RefObject } from "react";

import type { AnchorDraft } from "./artifact-anchor-places";
import { linesAdapter, type LineIndex } from "./artifact-line-ranges";
import { textAdapter, type TextIndex } from "./artifact-text-ranges";

export type OfferInput<Index> = {
  get: () => Index | null;
  revision: number;
  content: RefObject<Element | null>;
  key: string | null;
  composing: RefObject<boolean>;
};

export type Offer = {
  offered: AnchorDraft | null;
  paintOffer: boolean;
  autoCompose?: boolean;
  onDismiss: () => void;
  onContentClick?: (event: MouseEvent) => void;
};

export function useTextOffer({ get, content, key, composing }: OfferInput<TextIndex>): Offer {
  const [selected, setSelected] = useState<{ key: string; draft: AnchorDraft } | null>(null);

  useEffect(() => {
    const element = content.current;
    if (key === null || !element) return;
    let pointerDown = false;
    let holding = false;
    const evaluate = () => {
      if (composing.current) return;
      const selection = window.getSelection();
      const index = get();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !index)
        return setSelected(null);
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return setSelected(null);
      const draft = textAdapter.fromSelection(index, range);
      setSelected(draft && { key, draft });
    };
    const onChange = () => {
      if (!pointerDown && !holding) evaluate();
    };
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-comment-selection]")) holding = true;
      else if (element.contains(event.target)) pointerDown = true;
    };
    const onUp = () => {
      holding = false;
      if (!pointerDown) return;
      pointerDown = false;
      window.setTimeout(evaluate, 0);
    };
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      setSelected(null);
    };
  }, [content, key, get, composing]);

  return {
    offered: selected && selected.key === key ? selected.draft : null,
    paintOffer: false,
    onDismiss: () => {
      setSelected(null);
      window.getSelection()?.removeAllRanges();
    },
  };
}

type LineSelection = { key: string; origin: number; start: number; end: number };

export function useLinesOffer({ get, revision, key, composing }: OfferInput<LineIndex>): Offer {
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const current = selection && selection.key === key ? selection : null;
  useEffect(() => () => setSelection(null), [key]);
  const offered = useMemo(() => {
    const index = current && get();
    return current && index
      ? linesAdapter.fromSelection(index, { start: current.start, end: current.end })
      : null;
  }, [current, get, revision]);

  return {
    offered,
    paintOffer: true,
    onDismiss: () => setSelection(null),
    onContentClick: (event) => {
      if (key === null || composing.current || !(event.target instanceof Element)) return;
      const line = Number(
        event.target.closest("[data-anchor-select]")?.getAttribute("data-anchor-select"),
      );
      if (!Number.isInteger(line) || line < 1) return;
      setSelection((previous) => {
        const held = previous && previous.key === key ? previous : null;
        if (event.shiftKey && held)
          return {
            key,
            origin: held.origin,
            start: Math.min(held.origin, line),
            end: Math.max(held.origin, line),
          };
        if (held && held.start === line && held.end === line) return null;
        return { key, origin: line, start: line, end: line };
      });
    },
  };
}
