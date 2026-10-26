import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { m } from "#src/paraglide/messages";
import {
  rangeLocator,
  sectionAt,
  sectionLocator,
  type AttachmentCommentAnchor,
} from "./attachment-comment-anchors";
import {
  ANCHOR_HIGHLIGHT_MS,
  rangeAnchor,
  startNode,
  useSelectionComment,
  type Anchoring,
} from "./attachment-anchoring";
import { MessageBody } from "./message-body";

const HEADING_HIGHLIGHT = ["bg-tertiary", "ring-2", "ring-brand/50", "rounded"];
const RANGE_HIGHLIGHT = "bg-tertiary";
/** A jump marks at most this many lines or rows, as Raft does for rows. */
const MARKED_MAX = 200;
/** Rows or lines rendered at once; the rest follow a chunk at a time, after the first paint. */
const RENDER_CHUNK = 500;

/** The h1–h3 headings of a rendered Markdown file: its sections, as in Raft. */
const headingsIn = (element: HTMLElement | null) => [
  ...(element?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? []),
];
const titlesOf = (headings: HTMLElement[]) => headings.map((heading) => heading.textContent ?? "");

/**
 * A Markdown attachment through the message renderer: a selection is commented on under the
 * nearest h1–h3 heading at or above where it starts.
 */
export function MarkdownPreview({ text, anchoring }: { text: string; anchoring?: Anchoring }) {
  const ref = useRef<HTMLDivElement>(null);
  const toAnchor = useCallback((range: Range) => {
    const headings = headingsIn(ref.current);
    const start = startNode(range);
    let index = -1;
    headings.forEach((heading, i) => {
      const position = heading.compareDocumentPosition(start);
      if (heading.contains(start) || position & Node.DOCUMENT_POSITION_FOLLOWING) index = i;
    });
    const section = sectionAt(titlesOf(headings), index);
    return section ? ({ type: "md-section", data: section } as const) : null;
  }, []);
  const commentButton = useSelectionComment(ref, toAnchor, anchoring);
  useEffect(() => {
    if (!anchoring) return;
    // Headings are read once per rendered file; only a jump needs the live element again.
    const locateSection = sectionLocator(titlesOf(headingsIn(ref.current)));
    const locate = (anchor: AttachmentCommentAnchor) =>
      anchor.type === "md-section" ? locateSection(anchor.data) : null;
    anchoring.onSurface({
      locate,
      jump(anchor) {
        const index = locate(anchor);
        const heading = index === null ? undefined : headingsIn(ref.current)[index];
        if (!heading) return;
        heading.scrollIntoView({ block: "start", behavior: "smooth" });
        heading.classList.add(...HEADING_HIGHLIGHT);
        setTimeout(() => heading.classList.remove(...HEADING_HIGHLIGHT), ANCHOR_HIGHLIGHT_MS);
      },
    });
    return () => anchoring.onSurface(null);
  }, [text, anchoring]);
  // The outline lists the same h1–h3 a section comment is placed under, once they are rendered.
  const [outline, setOutline] = useState<{ title: string; level: number }[]>([]);
  useEffect(() => {
    setOutline(
      headingsIn(ref.current).map((heading) => ({
        title: heading.textContent ?? "",
        level: Number(heading.tagName.slice(1)),
      })),
    );
  }, [text]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto bg-secondary px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto flex max-w-6xl items-start justify-center gap-12">
        {outline.length > 0 && (
          <nav
            aria-label={m.attachment_preview_outline_label()}
            className="sticky top-0 hidden w-48 shrink-0 border-l border-secondary pl-4 lg:block"
          >
            <p className="mb-2 text-xs font-semibold text-tertiary">
              {m.attachment_preview_outline()}
            </p>
            <ul className="space-y-1.5">
              {outline.map((entry, index) => (
                <li key={index} style={{ paddingLeft: `${(entry.level - 1) * 0.75}rem` }}>
                  <AriaButton
                    className="block max-w-full cursor-pointer truncate text-left text-xs text-tertiary outline-brand hover:text-secondary focus-visible:outline-2"
                    onPress={() =>
                      headingsIn(ref.current)[index]?.scrollIntoView({
                        block: "start",
                        behavior: "smooth",
                      })
                    }
                  >
                    {entry.title}
                  </AriaButton>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article className="markdown-preview w-full max-w-3xl min-w-0 rounded-xl border border-secondary bg-primary px-6 py-8 text-md text-primary sm:px-10 sm:py-12">
          <MessageBody body={text} />
        </article>
      </div>
      {commentButton}
    </div>
  );
}

const toLineAnchor = rangeAnchor("lines", "data-anchor-line");

/**
 * Plain text, read literally, one element per line so a selection maps to its lines and a comment
 * on lines can be scrolled to. Rendered as React text: auto-escaped, no script surface.
 */
export function LinesPreview({ text, anchoring }: { text: string; anchoring?: Anchoring }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const { chunks, ensure } = useProgressiveChunks(lines.length);
  const commentButton = useSelectionComment(ref, toLineAnchor, anchoring);
  const lineTexts = useCallback(() => lines, [lines]);
  useRangeSurface(anchoring, "lines", lineTexts, ref, ensure);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto bg-secondary p-4 sm:p-6">
      <pre className="rounded-xl border border-secondary bg-primary px-4 py-4 font-mono text-sm break-words whitespace-pre-wrap text-primary sm:px-5">
        {chunks.map(([start, end]) => (
          <LineRun key={start} lines={lines} start={start} end={end} />
        ))}
      </pre>
      {commentButton}
    </div>
  );
}

/** One chunk of lines, laid out only near the viewport: a long file is tens of thousands. */
const LineRun = memo(function LineRun({
  lines,
  start,
  end,
}: {
  lines: readonly string[];
  start: number;
  end: number;
}) {
  return (
    <div style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${end - start}lh` }}>
      {lines.slice(start, end).map((line, index) => (
        <div key={start + index} data-anchor-line={start + index + 1} className="min-h-[1lh]">
          {line}
        </div>
      ))}
    </div>
  );
});

/**
 * The `[start, end)` chunks of `total` lines or rows rendered so far. A 2 MB file holds tens of
 * thousands, and rendering them in one go blocks the page for a second; chunks keep each step
 * short while every line still ends up in the page, so selecting and finding text work as usual.
 * `ensure` asks for everything up to a line at once, for a jump past what is rendered yet.
 */
export function useProgressiveChunks(total: number) {
  const [count, setCount] = useState(() => Math.min(total, RENDER_CHUNK));
  useEffect(() => setCount(Math.min(total, RENDER_CHUNK)), [total]);
  useEffect(() => {
    if (count >= total) return;
    const timer = setTimeout(() => setCount((n) => Math.min(total, n + RENDER_CHUNK)), 0);
    return () => clearTimeout(timer);
  }, [count, total]);
  const ensure = useCallback(
    (n: number) => setCount((current) => Math.max(current, Math.min(total, n))),
    [total],
  );
  const chunks = Array.from(
    { length: Math.ceil(count / RENDER_CHUNK) },
    (_, chunk) => [chunk * RENDER_CHUNK, Math.min(total, (chunk + 1) * RENDER_CHUNK)] as const,
  );
  return { chunks, ensure };
}

/**
 * Tells the dialog where a preview's line or row anchors sit, from each line's (or row's) text,
 * and jumps by rendering up to the range, scrolling its first line or row into view and marking
 * at most `MARKED_MAX` of them for a moment, so a huge range does not repaint the whole file.
 */
export function useRangeSurface(
  anchoring: Anchoring | undefined,
  type: "lines" | "csv-rows",
  texts: () => readonly string[],
  container: React.RefObject<HTMLElement | null>,
  ensure: (n: number) => void,
) {
  useEffect(() => {
    if (!anchoring) return;
    const attribute = type === "lines" ? "data-anchor-line" : "data-anchor-row";
    let locateRange: ReturnType<typeof rangeLocator> | undefined;
    const place = (anchor: AttachmentCommentAnchor) =>
      anchor.type === type ? (locateRange ??= rangeLocator(texts()))(anchor.data) : null;
    anchoring.onSurface({
      locate: (anchor) => place(anchor)?.start ?? null,
      jump(anchor) {
        const range = place(anchor);
        if (!range) return;
        const last = Math.min(range.end, range.start + MARKED_MAX - 1);
        ensure(last);
        const element = (n: number) =>
          container.current?.querySelector(`[${attribute}="${n}"]`) ?? null;
        // A range past what is rendered appears once React has committed the rows it asked for.
        const mark = (frames: number) => {
          if (!element(last) && frames > 0) {
            requestAnimationFrame(() => mark(frames - 1));
            return;
          }
          const marked = Array.from({ length: last - range.start + 1 }, (_, i) =>
            element(range.start + i),
          ).filter((found): found is Element => found !== null);
          marked[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
          for (const found of marked) found.classList.add(RANGE_HIGHLIGHT);
          setTimeout(() => {
            for (const found of marked) found.classList.remove(RANGE_HIGHLIGHT);
          }, ANCHOR_HIGHLIGHT_MS);
        };
        mark(120);
      },
    });
    return () => anchoring.onSurface(null);
  }, [anchoring, type, texts, container, ensure]);
}
