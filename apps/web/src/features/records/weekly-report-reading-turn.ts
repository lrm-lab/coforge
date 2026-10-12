/** Extra wheel distance, after the page body is already at its edge, that turns one page. */
export const READING_WHEEL_THRESHOLD = 80;

/** Gap with no wheel events that ends the current gesture so the next one can turn again. */
export const READING_WHEEL_QUIET_MS = 160;

const CONTENT_EDGE_SLACK = 24;

export type ReadingEdge = "start" | "end";

export type ReadingWheelGesture = {
  carry: number;
  armed: boolean;
  lastAt: number;
};

export function initialReadingWheelGesture(): ReadingWheelGesture {
  return { carry: 0, armed: false, lastAt: Number.NEGATIVE_INFINITY };
}

type SubmissionRef = { id: string; sourceTemplateId: string | null };

/** Previous and next submitted person of the same template in this week. */
export function sameTemplateNeighbors(
  weeks: readonly { submissions: readonly SubmissionRef[] }[],
  reportId: string,
): { previousId: string | null; nextId: string | null } {
  for (const week of weeks) {
    const current = week.submissions.find((row) => row.id === reportId);
    if (!current) continue;
    const chain = week.submissions.filter(
      (row) => row.sourceTemplateId === current.sourceTemplateId,
    );
    const index = chain.findIndex((row) => row.id === reportId);
    return {
      previousId: chain[index - 1]?.id ?? null,
      nextId: chain[index + 1]?.id ?? null,
    };
  }
  return { previousId: null, nextId: null };
}

export function stepMemberReportPage(input: {
  pageIds: readonly string[];
  activePageId: string;
  direction: -1 | 1;
  previousReportId: string | null;
  nextReportId: string | null;
}):
  | { kind: "page"; pageId: string; edge: ReadingEdge }
  | { kind: "report"; reportId: string; edge: ReadingEdge }
  | { kind: "stay" } {
  const index = input.pageIds.indexOf(input.activePageId);
  if (index < 0) return { kind: "stay" };
  const nextIndex = index + input.direction;
  if (nextIndex >= 0 && nextIndex < input.pageIds.length) {
    const pageId = input.pageIds[nextIndex];
    if (!pageId) return { kind: "stay" };
    return { kind: "page", pageId, edge: input.direction > 0 ? "start" : "end" };
  }
  const reportId = input.direction > 0 ? input.nextReportId : input.previousReportId;
  if (!reportId) return { kind: "stay" };
  return { kind: "report", reportId, edge: input.direction > 0 ? "start" : "end" };
}

/**
 * While the body is pinned to the edge, sum wheel distance until one step.
 * Further events in that gesture do not step again.
 */
export function noteReadingWheel(
  gesture: ReadingWheelGesture,
  input: { deltaY: number; pinned: boolean; now: number },
): { gesture: ReadingWheelGesture; step: -1 | 0 | 1 } {
  const quiet = input.now - gesture.lastAt > READING_WHEEL_QUIET_MS;
  const armed = gesture.armed && !quiet;
  if (!input.pinned || input.deltaY === 0) {
    return {
      gesture: { armed, carry: 0, lastAt: input.now },
      step: 0,
    };
  }
  if (armed) {
    return { gesture: { armed: true, carry: 0, lastAt: input.now }, step: 0 };
  }
  const sameDirection = gesture.carry === 0 || Math.sign(gesture.carry) === Math.sign(input.deltaY);
  const carry = (quiet ? 0 : sameDirection ? gesture.carry : 0) + input.deltaY;
  if (Math.abs(carry) < READING_WHEEL_THRESHOLD) {
    return { gesture: { armed: false, carry, lastAt: input.now }, step: 0 };
  }
  return {
    gesture: { armed: true, carry: 0, lastAt: input.now },
    step: input.deltaY > 0 ? 1 : -1,
  };
}

/** `deltaMode` 1 is lines, 2 is pages. Other values are already pixels. */
export function readingWheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

/** Whether the scroller is at the top, and whether the body sentinel has reached the viewport. */
export function contentEdgeReached(input: {
  scrollTop: number;
  clientHeight: number;
  contentEnd: number;
}): { atStart: boolean; atEnd: boolean } {
  return {
    atStart: input.scrollTop <= CONTENT_EDGE_SLACK,
    atEnd: input.contentEnd <= input.scrollTop + input.clientHeight + CONTENT_EDGE_SLACK,
  };
}

let stagedEdge: { reportId: string; edge: ReadingEdge } | null = null;

export function stageReadingEdge(reportId: string, edge: ReadingEdge) {
  stagedEdge = { reportId, edge };
}

export function readReadingEdge(reportId: string): ReadingEdge | null {
  if (stagedEdge?.reportId !== reportId) return null;
  return stagedEdge.edge;
}

export function clearReadingEdge(reportId: string) {
  if (stagedEdge?.reportId === reportId) stagedEdge = null;
}

let sessionGesture = initialReadingWheelGesture();

const readingWheel = {
  get current() {
    return sessionGesture;
  },
  set current(value: ReadingWheelGesture) {
    sessionGesture = value;
  },
};

/** One gesture shared across report remounts, so inertia does not turn a second page. */
export function readingWheelSession() {
  return readingWheel;
}

export function resetReadingWheelSession() {
  sessionGesture = initialReadingWheelGesture();
}
