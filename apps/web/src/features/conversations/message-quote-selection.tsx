import { useCallback, useEffect, useRef, useState } from "react";
import { Code02, Copy01, CornerUpLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { formatSelectionQuote, selectionAffordancePlacement } from "./message-quote";
import { copyFragmentMarkdown, copyFragmentStyled, selectionFragmentHtml } from "./selection-copy";

/** The vertical edges of the visible region a floating control must stay inside: the nearest
 * scrollport ancestor's box, or the viewport when the element is not inside a scroller. */
function visibleBoundary(el: HTMLElement): { top: number; bottom: number } {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const { top, bottom } = node.getBoundingClientRect();
      return { top, bottom };
    }
    node = node.parentElement;
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * A message row's reply-to-selection: reads the reader's highlight inside the row's body (`bodyRef`)
 * and holds the offer `QuoteSelectionBar` shows. Inert without `onQuoteSelection`.
 */
export function useQuoteSelection({
  onQuoteSelection,
  author,
  time,
}: {
  onQuoteSelection?: (quote: string) => void;
  /** The quoted message's sender and clock time, as the quote's attribution line. */
  author: string;
  time: string;
}) {
  // Reply-to-selection: the browser owns the highlight, this row only decides whether to *offer*
  // the action. The offer is made from a completed pointer gesture, so a drag that merely passes
  // over this message while selecting another one never raises it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const quoteAffordanceRef = useRef<HTMLDivElement>(null);
  /** Whether the latest pointer press was a finger or a pen rather than a mouse: a selection made
   * that way raises the platform's own edit menu above the highlight, so the bar goes below it. */
  const touchSelectionRef = useRef(false);
  const [quoteOffer, setQuoteOffer] = useState<
    { quote: string; html: string; text: string; top: number; left: number } | undefined
  >(undefined);
  /**
   * Reads the current highlight, and offers the quote only when the whole selection lives inside
   * this message's body: a highlight that spans rows cannot be credited to one of them, and a
   * quote that silently dropped half the selected text would be worse than no affordance.
   */
  const readQuoteSelection = useCallback(() => {
    if (!onQuoteSelection) return;
    const container = bodyRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteOffer(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setQuoteOffer(undefined);
      return;
    }
    const quote = formatSelectionQuote(
      {
        author,
        time,
      },
      selection.toString(),
    );
    if (!quote) {
      setQuoteOffer(undefined);
      return;
    }
    // Centered on the highlight, above it for a mouse selection and below it for a touch one
    // (the platform's own edit menu takes the space above); the visible history scroller is the
    // flip boundary, so the bar only changes side when it would scroll out of view. The
    // fragment and its text are captured now: clicking a bar button may collapse the live
    // selection, but the copy actions must still carry what the reader highlighted.
    const placement = selectionAffordancePlacement(
      range.getBoundingClientRect(),
      container.getBoundingClientRect(),
      visibleBoundary(container),
      touchSelectionRef.current ? "below" : "above",
    );
    setQuoteOffer({
      quote,
      html: selectionFragmentHtml(range),
      text: selection.toString(),
      ...placement,
    });
  }, [onQuoteSelection, author, time]);
  // A gesture anywhere else (a click, a scroll, Escape) withdraws the offer. The affordance
  // itself is exempt: pointerdown on it would otherwise unmount the button before its click.
  useEffect(() => {
    if (!quoteOffer) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && quoteAffordanceRef.current?.contains(event.target))
        return;
      setQuoteOffer(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(event);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [quoteOffer]);
  // Touch selection ends without a mouseup: the long-press and the OS selection handles fire no
  // usable mouse events, so on touch the offer is driven by `selectionchange` (debounced, so a
  // handle drag settles first) and by pointer release. While a pointer is down — a mouse drag
  // mid-selection — selection events are ignored and `onMouseUp` stays the trigger, keeping the
  // desktop bar tied to the completed gesture.
  const pointerDownRef = useRef(false);
  useEffect(() => {
    if (!onQuoteSelection) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(readQuoteSelection, 200);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = true;
      touchSelectionRef.current = event.pointerType !== "mouse";
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
      schedule();
    };
    const onSelectionChange = () => {
      if (!pointerDownRef.current) schedule();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onQuoteSelection, readQuoteSelection]);
  return {
    bodyRef,
    barRef: quoteAffordanceRef,
    offer: quoteOffer,
    read: readQuoteSelection,
    dismiss: () => setQuoteOffer(undefined),
  };
}

export function QuoteSelectionBar({
  selection: { offer, barRef, dismiss },
  onQuote,
}: {
  selection: ReturnType<typeof useQuoteSelection>;
  onQuote: (quote: string) => void;
}) {
  const toast = useAppToast();
  if (!offer) return null;
  return (
    <div
      ref={barRef}
      style={{ top: offer.top, left: offer.left }}
      className="absolute z-10 flex items-center gap-0.5 rounded-md border border-secondary bg-primary p-0.5 shadow-lg"
    >
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={CornerUpLeft}
        tooltip={m.conversation_quote_selection()}
        onClick={() => {
          onQuote(offer.quote);
          dismiss();
        }}
      />
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-secondary" />
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={Copy01}
        tooltip={m.conversation_copy_as_style()}
        onClick={() => {
          void copyFragmentStyled(offer.html, offer.text).then((copied) => {
            if (copied) toast.success(m.conversation_copy_as_style_success());
            else toast.error(m.conversation_copy_failed());
          });
          dismiss();
        }}
      />
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-secondary" />
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={Code02}
        tooltip={m.conversation_copy_as_markdown()}
        onClick={() => {
          void copyFragmentMarkdown(offer.html).then((copied) => {
            if (copied) toast.success(m.conversation_copy_as_markdown_success());
            else toast.error(m.conversation_copy_failed());
          });
          dismiss();
        }}
      />
    </div>
  );
}
