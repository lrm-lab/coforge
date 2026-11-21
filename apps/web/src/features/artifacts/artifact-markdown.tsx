import { useCallback, useEffect, useRef, useState } from "react";

import { ContentEditor } from "#src/features/records/report-editor/content-editor";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { cn } from "#src/lib/utils";
import { ArtifactCommentSurface } from "./artifact-comment-surface";
import {
  applyFindHighlights,
  clearFindHighlights,
  findDomMatches,
  scrollRangeIntoView,
  stepMatchIndex,
} from "./artifact-markdown-find";
import { ArtifactMarkdownOutline, useMarkdownOutline } from "./artifact-markdown-outline";
import { PageFindBar } from "./artifact-page-notices";
import "./artifact-markdown.css";

export type ArtifactMarkdownProps = {
  path: string;
  text: string;
  findOpen?: boolean;
  onFindClose?: () => void;
};

export function ArtifactMarkdown({
  path,
  text,
  findOpen = false,
  onFindClose,
}: ArtifactMarkdownProps) {
  const reducedMotion = usePrefersReducedMotion();
  const markdownRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef("");
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(-1);
  const [total, setTotal] = useState(0);
  const [findActiveIndex, setFindActiveIndex] = useState(-1);

  const {
    headings,
    activeIndex: outlineActiveIndex,
    scrollToHeading,
    contentRevision,
  } = useMarkdownOutline(markdownRef, `${path}\0${text}`);

  const resetFind = useCallback(() => {
    queryRef.current = "";
    rangesRef.current = [];
    activeIndexRef.current = -1;
    setTotal(0);
    setFindActiveIndex(-1);
    clearFindHighlights();
  }, []);

  useEffect(() => {
    if (!findOpen) resetFind();
  }, [findOpen, resetFind]);

  useEffect(() => {
    resetFind();
  }, [path, resetFind]);

  useEffect(() => clearFindHighlights, []);

  useEffect(() => {
    if (!findOpen || queryRef.current === "" || !markdownRef.current) return;
    const ranges = findDomMatches(markdownRef.current, queryRef.current);
    rangesRef.current = ranges;
    const nextIndex =
      ranges.length === 0 ? -1 : Math.min(Math.max(activeIndexRef.current, 0), ranges.length - 1);
    activeIndexRef.current = nextIndex;
    setTotal(ranges.length);
    setFindActiveIndex(nextIndex);
    applyFindHighlights(ranges, nextIndex);
  }, [findOpen, contentRevision]);

  const handleFind = useCallback(
    (nextQuery: string, step: number) => {
      if (nextQuery === "") {
        resetFind();
        return;
      }
      if (nextQuery !== queryRef.current || step === 0) {
        queryRef.current = nextQuery;
        const ranges = markdownRef.current ? findDomMatches(markdownRef.current, nextQuery) : [];
        rangesRef.current = ranges;
        const nextIndex = ranges.length > 0 ? 0 : -1;
        activeIndexRef.current = nextIndex;
        setTotal(ranges.length);
        setFindActiveIndex(nextIndex);
        applyFindHighlights(ranges, nextIndex);
        if (nextIndex >= 0) scrollRangeIntoView(ranges[nextIndex]!, reducedMotion);
        return;
      }
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const nextIndex = stepMatchIndex(activeIndexRef.current, ranges.length, step);
      activeIndexRef.current = nextIndex;
      setFindActiveIndex(nextIndex);
      applyFindHighlights(ranges, nextIndex);
      if (nextIndex >= 0) scrollRangeIntoView(ranges[nextIndex]!, reducedMotion);
    },
    [reducedMotion, resetFind],
  );

  const handleFindClose = useCallback(() => {
    resetFind();
    onFindClose?.();
  }, [onFindClose, resetFind]);

  const hasOutline = headings.length >= 2;

  return (
    <div className="@container/md-reader relative flex min-h-0 flex-1 flex-col">
      {findOpen && (
        <PageFindBar
          key={path}
          found={{ total, active: findActiveIndex >= 0 ? findActiveIndex + 1 : 0 }}
          onFind={handleFind}
          onClose={handleFindClose}
        />
      )}
      <ArtifactCommentSurface
        path={path}
        kind="text"
        contentClassName="w-full px-6 pt-8 pb-16 md:px-10"
      >
        <div
          className={cn(
            "mx-auto w-full",
            hasOutline &&
              "@5xl/md-reader:grid @5xl/md-reader:grid-cols-[minmax(11rem,1fr)_minmax(0,46rem)_minmax(0,1fr)] @5xl/md-reader:gap-8",
          )}
        >
          {hasOutline && (
            <aside
              key="outline"
              data-anchor-chrome=""
              className="sticky top-8 ml-auto hidden w-[12.5rem] self-start @5xl/md-reader:block"
            >
              <ArtifactMarkdownOutline
                headings={headings}
                activeIndex={outlineActiveIndex}
                onSelect={scrollToHeading}
              />
            </aside>
          )}
          <div
            key="content"
            ref={markdownRef}
            className={cn(
              "mx-auto w-full max-w-[46rem] min-w-0",
              hasOutline && "@5xl/md-reader:col-start-2 @5xl/md-reader:mx-0",
            )}
          >
            <ContentEditor editable={false} defaultValue={text} />
          </div>
        </div>
      </ArtifactCommentSurface>
    </div>
  );
}
