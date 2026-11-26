import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { computePosition, flip, offset, shift, type VirtualElement } from "@floating-ui/dom";
import { Separator, Toolbar } from "react-aria-components";
import { Code02, Copy01, CornerUpLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { formatSelectionQuote } from "./message-quote";
import { copyFragmentMarkdown, copyFragmentStyled, selectionFragmentHtml } from "./selection-copy";

type QuoteOffer = {
  container: HTMLElement;
  quote: string;
  html: string;
  text: string;
  rect: DOMRect;
  prefer: "above" | "below";
};

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
    setOffer({
      container: body,
      quote,
      html: selectionFragmentHtml(range),
      text: selection.toString(),
      rect: range.getBoundingClientRect(),
      prefer: touchSelectionRef.current ? "below" : "above",
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

  if (!onQuote || !offer || !offer.container.isConnected || typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <QuoteSelectionBar offer={offer} barRef={barRef} dismiss={dismiss} onQuote={onQuote} />,
    document.body,
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

  useLayoutEffect(() => {
    const floating = barRef.current;
    if (!floating) return;
    let cancelled = false;
    const reference: VirtualElement = {
      getBoundingClientRect: () => offer.rect,
      contextElement: offer.container,
    };
    void computePosition(reference, floating, {
      strategy: "fixed",
      placement: offer.prefer === "below" ? "bottom" : "top",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (cancelled || !floating.isConnected) return;
      floating.style.left = `${x}px`;
      floating.style.top = `${y}px`;
      floating.style.visibility = "visible";
    });
    return () => {
      cancelled = true;
    };
  }, [offer, barRef]);

  return (
    <Toolbar
      ref={barRef}
      aria-label={m.conversation_quote_selection()}
      style={{ visibility: "hidden" }}
      className="fixed top-0 left-0 z-50 flex items-center gap-0.5 rounded-md border border-secondary bg-primary p-0.5 shadow-lg"
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
      <Separator orientation="vertical" className="h-4 w-px shrink-0 bg-secondary" />
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
      <Separator orientation="vertical" className="h-4 w-px shrink-0 bg-secondary" />
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
    </Toolbar>
  );
}
