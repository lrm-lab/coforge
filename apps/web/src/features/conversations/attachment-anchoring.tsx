import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageSquare01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import {
  ANCHOR_QUOTE_MAX,
  storedText,
  type AttachmentCommentAnchor,
} from "./attachment-comment-anchors";

/** What a preview tells its review dialog about the file it shows, once its content is ready. */
export type AnchorSurface = {
  /** The anchor's place in the document now (smaller is earlier), or `null` when it is lost. */
  locate(anchor: AttachmentCommentAnchor): number | null;
  /** Scrolls the preview to the anchor and marks it for a moment. */
  jump(anchor: AttachmentCommentAnchor): void;
};

/** How a preview that can place comments talks to its review dialog. */
export type Anchoring = {
  onSurface(surface: AnchorSurface | null): void;
  /** Opens the comment box about `anchor`, or about the whole file for `null`. */
  onComment(anchor: AttachmentCommentAnchor | null): void;
};

/** How long a jumped-to place stays marked. */
export const ANCHOR_HIGHLIGHT_MS = 2_000;

/** The nearest element holding `node` that carries `attribute`, e.g. a line or row. */
const numberedElement = (node: Node | null, attribute: string) =>
  (node instanceof Element ? node : node?.parentElement)?.closest(`[${attribute}]`) ?? null;

/** The number in `attribute` on the nearest element holding `node`, e.g. a line's or row's. */
export function numberedAncestor(node: Node | null, attribute: string): number | null {
  const value = numberedElement(node, attribute)?.getAttribute(attribute);
  return value ? Number(value) : null;
}

/**
 * The node a selection starts in: for a boundary between an element's children, the child after it.
 */
export function startNode(range: Range): Node {
  const { startContainer: node, startOffset: offset } = range;
  return node instanceof Element ? (node.childNodes[offset] ?? node) : node;
}

/**
 * The line or row range a selection spans, read from the numbered elements it starts and ends in.
 * A selection that ends where a line begins (a triple click selects up to the next one) holds
 * nothing of that line, so it ends on the line before.
 */
export function rangeAnchor(type: "lines" | "csv-rows", attribute: string) {
  return (range: Range): AttachmentCommentAnchor | null => {
    const start = numberedAncestor(startNode(range), attribute);
    const { endContainer: node, endOffset: offset } = range;
    const last =
      node instanceof Element && offset > 0 ? (node.childNodes[offset - 1] ?? node) : node;
    const ending = numberedElement(last, attribute);
    let end = numberedAncestor(last, attribute);
    if (start && end && end > start && ending && last === node) {
      const lead = document.createRange();
      lead.setStart(ending, 0);
      lead.setEnd(node, offset);
      if (lead.toString() === "") end -= 1;
    }
    return start && end ? { type, data: { start, end } } : null;
  };
}

/**
 * The comment button that follows the reader's text selection inside `container`, just below it,
 * once `toAnchor` can place the selection (its anchor without the quote). A selection outside the
 * preview or one it cannot place offers nothing, and scrolling drops the offer, as the button would no longer sit by the
 * selection. Selection changes are read once per frame, and the selected text is only read when
 * the button is pressed. Nothing renders without `anchoring`.
 */
export function useSelectionComment(
  container: RefObject<HTMLElement | null>,
  toAnchor: (range: Range) => AttachmentCommentAnchor | null,
  anchoring: Anchoring | undefined,
): ReactNode {
  const [offer, setOffer] = useState<{ anchor: AttachmentCommentAnchor; rect: DOMRect } | null>(
    null,
  );
  useEffect(() => {
    const element = container.current;
    if (!element || !anchoring) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return setOffer(null);
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return setOffer(null);
      const anchor = toAnchor(range);
      setOffer(anchor ? { anchor, rect: range.getBoundingClientRect() } : null);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(read);
    };
    const drop = () => setOffer(null);
    document.addEventListener("selectionchange", schedule);
    element.addEventListener("scroll", drop, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      element.removeEventListener("scroll", drop, true);
    };
  }, [container, toAnchor, anchoring]);
  // Inside the open dialog: a modal hides the rest of the page and closes on a press outside.
  const host = container.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
  if (!offer || !anchoring || !host) return null;
  return createPortal(
    <div
      className="fixed z-50"
      style={{ top: offer.rect.bottom + 6, left: Math.max(8, offer.rect.left) }}
      // Keep the selection: a mouse press on the button must not collapse it first.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        size="sm"
        color="primary"
        iconLeading={MessageSquare01}
        onPress={() => {
          const selection = document.getSelection();
          const quote = selection ? storedText(selection.toString(), ANCHOR_QUOTE_MAX) : "";
          setOffer(null);
          selection?.removeAllRanges();
          // The quote is read now, once, rather than on every change of the selection.
          anchoring.onComment(
            quote
              ? ({
                  ...offer.anchor,
                  data: { ...offer.anchor.data, quote },
                } as AttachmentCommentAnchor)
              : offer.anchor,
          );
        }}
      >
        {m.attachment_comments_comment_selection()}
      </Button>
    </div>,
    host,
  );
}
