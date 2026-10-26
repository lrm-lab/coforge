import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { MessageSquare01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ANCHOR_QUOTE_MAX, storedText } from "./attachment-comment-anchors";
import { ANCHOR_HIGHLIGHT_MS, type Anchoring } from "./attachment-anchoring";
import {
  acceptBridgeMessage,
  bridgeMessage,
  bridgeSrcDoc,
  newBridgeSession,
  type BridgeState,
  type DocumentBox,
  type FrameMessage,
  type ParentMessage,
} from "./html-preview-bridge";

/** The smallest box a jump marks, so a clicked point still shows. */
const LOCATED_MIN = 14;
/** How long the page waits for the bridge to answer a request before going on without it. */
const BRIDGE_REPLY_MS = 1_000;
/** A wheel's line and page steps in pixels, for a delta not given in pixels. */
const WHEEL_STEP = [1, 16, 800] as const;

type Point = { x: number; y: number };
type Reply = Extract<FrameMessage, { id: number }>;

/**
 * An HTML file in a sandboxed frame, as in Raft 1.0.53: in `comment` mode a transparent layer over
 * the frame takes a click or a drag as a region to comment on, and a jump marks a region with a
 * box on that layer. Touch devices only preview, as Raft has it.
 */
export function HtmlRegionPreview({
  fileName,
  text,
  anchoring,
  commentsOpen,
}: {
  fileName: string;
  text: string;
  anchoring?: Anchoring;
  /** Whether the comments are showing beside the preview; hiding them ends comment mode. */
  commentsOpen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useMemo(() => newBridgeSession(), [text]);
  const srcDoc = useMemo(() => bridgeSrcDoc(session), [session]);
  const [view, setView] = useState<BridgeState | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const replies = useRef(new Map<number, (reply: Reply | null) => void>());
  const nextId = useRef(0);

  const post = useCallback(
    (message: ParentMessage) =>
      frame.current?.contentWindow?.postMessage(bridgeMessage(session, message), "*"),
    [session],
  );
  const request = useCallback(
    (message: Extract<ParentMessage, { id: number }>) =>
      new Promise<Reply | null>((resolve) => {
        replies.current.set(message.id, resolve);
        post(message);
        setTimeout(() => {
          if (replies.current.delete(message.id)) resolve(null);
        }, BRIDGE_REPLY_MS);
      }),
    [post],
  );

  useEffect(() => {
    setView(null);
    const onMessage = (event: MessageEvent) => {
      const message = acceptBridgeMessage(event, frame.current?.contentWindow, session);
      if (!message) return;
      if (message.type === "ready") post({ type: "render", html: text });
      else if (message.type === "state") {
        const { type: _, ...state } = message;
        setView(state);
      } else {
        const resolve = replies.current.get(message.id);
        replies.current.delete(message.id);
        resolve?.(message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [session, text, post]);

  const [located, setLocated] = useState<DocumentBox | null>(null);
  const rendered = view !== null;
  useEffect(() => {
    if (!anchoring || !rendered) return;
    let clear = 0;
    anchoring.onSurface({
      // Top to bottom, then left to right; a region is never lost (Raft falls back to its box).
      locate: (anchor) =>
        anchor.type === "html-region" ? anchor.data.y + anchor.data.x / 1e8 : null,
      async jump(anchor) {
        if (anchor.type !== "html-region") return;
        const { x, y, w, h, quote } = anchor.data;
        const reply = quote
          ? await request({ type: "locate", id: ++nextId.current, quote, hintY: y + h / 2 })
          : null;
        const box = (reply?.type === "located" && reply.box) || { x, y, w, h };
        const current = viewRef.current;
        if (current)
          post({
            type: "scrollTo",
            x: Math.max(0, box.x - current.viewportWidth / 2),
            y: Math.max(0, box.y - current.viewportHeight / 3),
          });
        setLocated(box);
        clearTimeout(clear);
        clear = window.setTimeout(() => setLocated(null), ANCHOR_HIGHLIGHT_MS);
      },
    });
    return () => {
      clearTimeout(clear);
      anchoring.onSurface(null);
    };
  }, [anchoring, rendered, request, post]);

  const coarse = useMediaQuery("(pointer: coarse)", false);
  const canMark = Boolean(anchoring) && !coarse;
  const [commenting, setCommenting] = useState(false);
  const active = commenting && canMark;
  useEffect(() => {
    if (!commentsOpen) setCommenting(false);
  }, [commentsOpen]);
  // Esc leaves comment mode before the dialog sees it, which would otherwise close.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setCommenting(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active]);

  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [marked, setMarked] = useState<DocumentBox | null>(null);
  useEffect(() => {
    if (!active) setMarked(null);
  }, [active]);
  const pointIn = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const finish = async (from: Point, to: Point) => {
    const current = viewRef.current;
    if (!anchoring) return;
    if (!current) return anchoring.onComment(null);
    const box = {
      x: Math.round(Math.min(from.x, to.x) + current.scrollX),
      y: Math.round(Math.min(from.y, to.y) + current.scrollY),
      w: Math.round(Math.abs(to.x - from.x)),
      h: Math.round(Math.abs(to.y - from.y)),
    };
    setMarked(box);
    const reply = await request({ type: "quoteAt", id: ++nextId.current, box });
    const quote = reply?.type === "quote" ? storedText(reply.quote, ANCHOR_QUOTE_MAX) : "";
    anchoring.onComment({
      type: "html-region",
      data: {
        ...box,
        viewportWidth: Math.round(current.viewportWidth),
        documentWidth: Math.round(current.documentWidth),
        documentHeight: Math.round(current.documentHeight),
        ...(quote ? { quote } : {}),
      },
    });
  };

  // A document box drawn on the layer, which sits exactly over the frame's viewport.
  const onLayer = (box: DocumentBox, min = 0) =>
    view
      ? {
          left: box.x - view.scrollX,
          top: box.y - view.scrollY,
          width: Math.max(min, box.w),
          height: Math.max(min, box.h),
        }
      : undefined;
  const dragBox = drag && {
    left: Math.min(drag.from.x, drag.to.x),
    top: Math.min(drag.from.y, drag.to.y),
    width: Math.abs(drag.to.x - drag.from.x),
    height: Math.abs(drag.to.y - drag.from.y),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 sm:px-6 sm:pt-4">
        <p className="min-w-0 flex-1 text-xs text-tertiary">
          {m.conversation_attachment_preview_html_note()}
        </p>
        {canMark && (
          <Button
            size="sm"
            color={active ? "primary" : "secondary"}
            iconLeading={MessageSquare01}
            aria-pressed={active}
            onClick={() => {
              if (!active) anchoring?.onOpenComments();
              setCommenting(!active);
            }}
          >
            {m.attachment_comments_comment_selection()}
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frame}
          // `aria-label` rather than `title`: the shared lint rule reserves `title` for the Tooltip
          // component, and an accessible name for a frame can come from either.
          aria-label={fileName}
          // Scripts, but in an opaque origin (no `allow-same-origin`), and only the bridge's: the
          // CSP in `srcDoc` admits the one script carrying this render's nonce. No forms, popups or
          // top navigation. See `html-preview-bridge.ts`.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className={cn(
            "absolute inset-0 h-full w-full border-0 bg-white",
            !rendered && "pointer-events-none",
          )}
        />
        {!rendered && (
          <p className="absolute inset-0 flex items-center justify-center bg-primary text-sm text-tertiary">
            {m.attachment_comments_preview_preparing()}
          </p>
        )}
        <div
          className={cn(
            "absolute inset-0 touch-none",
            active ? "cursor-crosshair" : "pointer-events-none",
          )}
          onPointerDown={(event) => {
            if (!active || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointIn(event);
            setMarked(null);
            setDrag({ from: point, to: point });
          }}
          onPointerMove={(event) => {
            if (drag) setDrag({ from: drag.from, to: pointIn(event) });
          }}
          onPointerUp={(event) => {
            if (!drag) return;
            const to = pointIn(event);
            setDrag(null);
            void finish(drag.from, to);
          }}
          onPointerCancel={() => setDrag(null)}
          onWheel={(event) => {
            if (!active) return;
            const step = WHEEL_STEP[event.deltaMode] ?? 1;
            post({ type: "scrollBy", x: event.deltaX * step, y: event.deltaY * step });
          }}
        >
          {active && (
            <p className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary-solid px-3 py-1.5 text-xs font-medium whitespace-nowrap text-white shadow-lg">
              {rendered
                ? m.attachment_comments_region_hint()
                : m.attachment_comments_region_unavailable()}
            </p>
          )}
          {dragBox && (
            <div
              className="pointer-events-none absolute rounded-xs border-2 border-brand bg-brand-solid/10"
              style={dragBox}
            />
          )}
          {!drag && marked && (
            <div
              className="pointer-events-none absolute rounded-xs border-2 border-brand bg-brand-solid/10"
              style={onLayer(marked)}
            />
          )}
          {located && (
            <div
              data-located=""
              className="pointer-events-none absolute rounded-xs bg-brand-solid/10 ring-2 ring-brand/50"
              style={onLayer(located, LOCATED_MIN)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
