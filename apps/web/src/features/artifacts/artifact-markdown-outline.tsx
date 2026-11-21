import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button as AriaButton } from "react-aria-components";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { findScrollContainer } from "./artifact-markdown-find";

export type OutlineHeading = {
  key: string;
  text: string;
  level: 1 | 2 | 3;
};

const HEADING_SELECTOR = "h1, h2, h3";
const ACTIVE_OFFSET_PX = 80;
const CLICK_LOCK_MS = 350;

export function pickActiveHeadingIndex(offsets: readonly number[], threshold: number): number {
  if (offsets.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i]! <= threshold) active = i;
    else break;
  }
  return active;
}

export function relativeHeadingDepth(level: 1 | 2 | 3, minLevel: 1 | 2 | 3): 0 | 1 | 2 {
  const diff = level - minLevel;
  if (diff <= 0) return 0;
  if (diff === 1) return 1;
  return 2;
}

function headingLevelOf(element: HTMLElement): 1 | 2 | 3 {
  if (element.tagName === "H1") return 1;
  if (element.tagName === "H2") return 2;
  return 3;
}

function extractMarkdownHeadings(root: Element): {
  headings: OutlineHeading[];
  elements: HTMLElement[];
} {
  const headings: OutlineHeading[] = [];
  const elements: HTMLElement[] = [];
  const matches = root.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
  for (const element of matches) {
    if (element.closest("[data-anchor-chrome]")) continue;
    const text = element.textContent?.trim() ?? "";
    if (text === "") continue;
    const level = headingLevelOf(element);
    const index = headings.length;
    headings.push({ key: `${index}:${level}:${text}`, text, level });
    elements.push(element);
  }
  return { headings, elements };
}

function sameHeadings(a: readonly OutlineHeading[], b: readonly OutlineHeading[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.key !== b[i]!.key) return false;
  }
  return true;
}

export function useMarkdownOutline(
  contentRef: RefObject<HTMLDivElement | null>,
  contentKey: string,
) {
  const reducedMotion = usePrefersReducedMotion();
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contentRevision, setContentRevision] = useState(0);
  const elementsRef = useRef<HTMLElement[]>([]);
  const headingsRef = useRef<OutlineHeading[]>([]);
  const lockUntilRef = useRef(0);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    let frame = 0;
    const scan = (bumpRevision: boolean) => {
      const next = extractMarkdownHeadings(root);
      elementsRef.current = next.elements;
      if (!sameHeadings(headingsRef.current, next.headings)) {
        headingsRef.current = next.headings;
        setHeadings(next.headings);
      }
      if (bumpRevision) setContentRevision((value) => value + 1);
    };

    const isChromeNode = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      return Boolean(element?.closest("[data-anchor-chrome]"));
    };

    scan(true);
    const observer = new MutationObserver((records) => {
      if (records.every((record) => isChromeNode(record.target))) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan(true);
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [contentRef, contentKey]);

  useEffect(() => {
    setActiveIndex(0);
    lockUntilRef.current = 0;
  }, [contentKey]);

  useEffect(() => {
    const root = contentRef.current;
    const elements = elementsRef.current;
    if (!root || elements.length < 2) return;

    const scroller = findScrollContainer(root);
    const updateActive = () => {
      if (performance.now() < lockUntilRef.current) return;
      const rootTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const offsets = elements.map((element) => element.getBoundingClientRect().top - rootTop);
      const next = pickActiveHeadingIndex(offsets, ACTIVE_OFFSET_PX);
      if (next >= 0) setActiveIndex(next);
    };

    updateActive();
    const observer = new IntersectionObserver(updateActive, {
      root: scroller,
      rootMargin: "0px 0px -70% 0px",
      threshold: [0, 1],
    });
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [contentRef, headings, contentRevision]);

  const scrollToHeading = useCallback(
    (index: number) => {
      const target = elementsRef.current[index];
      if (!target) return;
      lockUntilRef.current = performance.now() + CLICK_LOCK_MS;
      setActiveIndex(index);
      target.scrollIntoView({
        block: "start",
        behavior: reducedMotion ? "auto" : "smooth",
      });
    },
    [reducedMotion],
  );

  return { headings, activeIndex, scrollToHeading, contentRevision };
}

const DEPTH_INDENT = ["pl-3", "pl-5", "pl-7"] as const;

export function ArtifactMarkdownOutline({
  headings,
  activeIndex,
  onSelect,
  className,
}: {
  headings: readonly OutlineHeading[];
  activeIndex: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  const minLevel = useMemo<1 | 2 | 3>(() => {
    let min: 1 | 2 | 3 = 3;
    for (const heading of headings) {
      if (heading.level < min) min = heading.level;
    }
    return min;
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav
      aria-label={m.av_outline()}
      data-anchor-chrome=""
      className={cn("max-h-[calc(100dvh-6rem)] overflow-y-auto select-none", className)}
    >
      <div className="border-l border-secondary">
        <p className="pb-2.5 pl-3 text-xs font-semibold text-secondary">{m.av_outline()}</p>
        <ul className="space-y-0.5">
          {headings.map((heading, index) => {
            const active = index === activeIndex;
            const depth = relativeHeadingDepth(heading.level, minLevel);
            return (
              <li key={heading.key}>
                <AriaButton
                  aria-current={active ? "location" : undefined}
                  onPress={() => onSelect(index)}
                  className={cn(
                    "-ml-px block w-full cursor-pointer border-l-2 py-1 pr-2 text-left text-xs leading-5 outline-focus-ring transition-colors duration-150 focus-visible:outline-2",
                    DEPTH_INDENT[depth],
                    active
                      ? "border-brand font-medium text-primary"
                      : "border-transparent text-tertiary hover:border-primary hover:text-primary",
                  )}
                >
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">{heading.text}</span>
                </AriaButton>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
