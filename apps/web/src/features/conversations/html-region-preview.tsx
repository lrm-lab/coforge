import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Button as AriaButton } from "react-aria-components";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
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
  type FrameLink,
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
type View = BridgeState & { links: FrameLink[] };
type Reply = Extract<FrameMessage, { id: number }>;

/**
 * An HTML file in a sandboxed frame, as in Raft 1.0.53: while the comments show, a transparent layer
 * over the frame takes a click or a drag as a region to comment on, and a jump marks a region with
 * a light fill on that layer. Touch devices only preview, as Raft has it.
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
  /** Whether the comments are showing beside the preview, which is what comment mode is. */
  commentsOpen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useMemo(() => newBridgeSession(), [text]);
  const srcDoc = useMemo(() => bridgeSrcDoc(session), [session]);
  const [view, setView] = useState<View | null>(null);
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
  // As in Raft, showing the comments is comment mode: the one comment control does both.
  const active = Boolean(anchoring && commentsOpen) && !coarse;

  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  // Held inside the layer: a captured drag can carry the pointer past its edges.
  const pointIn = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height),
    };
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
  // Opened here, not in the frame, and only for `http`/`https`: the frame never navigates.
  const [blocked, setBlocked] = useState<string | null>(null);
  const openLink = (href: string) => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const opened = window.open(url.href, "_blank");
    if (opened) opened.opener = null;
    else setBlocked(url.href);
  };

  const dragBox = drag && {
    left: Math.min(drag.from.x, drag.to.x),
    top: Math.min(drag.from.y, drag.to.y),
    width: Math.abs(drag.to.x - drag.from.x),
    height: Math.abs(drag.to.y - drag.from.y),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
          // Also asks for the file once the bridge is listening, in case its `ready` went out
          // before this page's listener did; the bridge renders only the first request.
          onLoad={() => post({ type: "render", html: text })}
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
            "absolute inset-0",
            active ? "cursor-crosshair touch-none" : "pointer-events-none",
          )}
          onPointerDown={(event) => {
            if (!active || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointIn(event);
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
          // Over the layer, or a link's hotspot outside comment mode, the wheel still scrolls the
          // page under it.
          onWheel={(event) => {
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
          {!active &&
            view?.links.map((link, index) => (
              <AriaButton
                key={`${index}:${link.href}`}
                aria-label={link.href}
                className="pointer-events-auto absolute cursor-pointer outline-brand focus-visible:outline-2"
                style={{ left: link.x, top: link.y, width: link.w, height: link.h }}
                onPress={() => openLink(link.href)}
              />
            ))}
          {located && (
            <div
              data-located=""
              className="pointer-events-none absolute rounded-xs bg-utility-blue-100/80"
              style={onLayer(located, LOCATED_MIN)}
            />
          )}
        </div>
        {blocked && (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg bg-primary px-4 py-2 shadow-lg ring-1 ring-secondary">
            <p className="min-w-0 flex-1 text-sm text-secondary">
              {m.attachment_comments_popup_blocked()}
            </p>
            <Button
              size="sm"
              color="secondary"
              href={blocked}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setBlocked(null)}
            >
              {m.attachment_comments_open_link()}
            </Button>
            <ButtonUtility
              icon={XClose}
              size="xs"
              color="tertiary"
              tooltip={m.controls_close()}
              onClick={() => setBlocked(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
