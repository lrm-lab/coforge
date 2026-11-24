import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Code02, Copy01, CornerUpLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { formatSelectionQuote, selectionAffordancePlacement } from "./message-quote";
import { copyFragmentMarkdown, copyFragmentStyled, selectionFragmentHtml } from "./selection-copy";

type QuoteOffer = {
  container: HTMLElement;
  quote: string;
  html: string;
  text: string;
  top: number;
  left: number;
};

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

function resolveQuoteBody(history: HTMLElement, node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const body = element?.closest<HTMLElement>("[data-quote-body]") ?? null;
  if (!body || !history.contains(body) || !body.closest("[data-message-id]")) return null;
  return body;
}

export function PaneQuoteSelection({
  historyRef,
  conversationId,
  onQuote,
}: {
  historyRef: RefObject<HTMLDivElement | null>;
  conversationId: string;
  onQuote?: (quote: string) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const touchSelectionRef = useRef(false);
  const pointerDownRef = useRef(false);
  const offerRef = useRef<QuoteOffer | undefined>(undefined);
  const [offer, setOfferState] = useState<QuoteOffer | undefined>(undefined);

  const setOffer = useCallback((next: QuoteOffer | undefined) => {
    offerRef.current = next;
    setOfferState(next);
  }, []);

  const dismiss = useCallback(() => {
    if (offerRef.current !== undefined) setOffer(undefined);
  }, [setOffer]);

  useEffect(() => {
    dismiss();
  }, [conversationId, onQuote, dismiss]);

  const readQuoteSelection = useCallback(() => {
    if (!onQuote) return;
    const history = historyRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!history || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      dismiss();
      return;
    }
    const range = selection.getRangeAt(0);
    const body = resolveQuoteBody(history, range.commonAncestorContainer);
    if (!body || !body.contains(range.commonAncestorContainer)) {
      dismiss();
      return;
    }
    const quote = formatSelectionQuote(
      {
        author: body.dataset.quoteAuthor ?? "",
        time: body.dataset.quoteTime ?? "",
      },
      selection.toString(),
    );
    if (!quote) {
      dismiss();
      return;
    }
    const placement = selectionAffordancePlacement(
      range.getBoundingClientRect(),
      body.getBoundingClientRect(),
      visibleBoundary(body),
      touchSelectionRef.current ? "below" : "above",
    );
    setOffer({
      container: body,
      quote,
      html: selectionFragmentHtml(range),
      text: selection.toString(),
      ...placement,
    });
  }, [onQuote, historyRef, dismiss, setOffer]);

  useEffect(() => {
    if (!offer) return;
    const onDismiss = (event: Event) => {
      if (event.target instanceof Node && barRef.current?.contains(event.target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss(event);
    };
    document.addEventListener("pointerdown", onDismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onDismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [offer, dismiss]);

  useEffect(() => {
    if (!onQuote) return;
    const history = historyRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const currentHistory = historyRef.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      const hasCandidate =
        currentHistory !== null &&
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        currentHistory.contains(selection.anchorNode);
      if (!hasCandidate && offerRef.current === undefined) {
        clearTimeout(timer);
        return;
      }
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
    const onHistoryRelease = () => {
      readQuoteSelection();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    history?.addEventListener("mouseup", onHistoryRelease);
    history?.addEventListener("keyup", onHistoryRelease);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      history?.removeEventListener("mouseup", onHistoryRelease);
      history?.removeEventListener("keyup", onHistoryRelease);
    };
  }, [onQuote, historyRef, readQuoteSelection]);

  if (!onQuote || !offer || !offer.container.isConnected) return null;
  return createPortal(
    <QuoteSelectionBar offer={offer} barRef={barRef} dismiss={dismiss} onQuote={onQuote} />,
    offer.container,
  );
}

function QuoteSelectionBar({
  offer,
  barRef,
  dismiss,
  onQuote,
}: {
  offer: QuoteOffer;
  barRef: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
  onQuote: (quote: string) => void;
}) {
  const toast = useAppToast();
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
