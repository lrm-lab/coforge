import { expect, test } from "bun:test";

import {
  READING_WHEEL_QUIET_MS,
  READING_WHEEL_THRESHOLD,
  contentEdgeReached,
  initialReadingWheelGesture,
  noteReadingWheel,
  readingWheelPixels,
  readReadingEdge,
  readingWheelSession,
  resetReadingWheelSession,
  sameTemplateNeighbors,
  stageReadingEdge,
  stepMemberReportPage,
  clearReadingEdge,
} from "#src/features/records/weekly-report-reading-turn";

const pages = ["Summary", "Technique", "要点提炼"];

test("the next wheel step stays inside one template, then the next submitted person", () => {
  const weeks = [
    {
      submissions: [
        { id: "ann", sourceTemplateId: "format-a" },
        { id: "bo", sourceTemplateId: "format-b" },
        { id: "cy", sourceTemplateId: "format-a" },
      ],
    },
  ];

  expect(sameTemplateNeighbors(weeks, "ann")).toEqual({ previousId: null, nextId: "cy" });
  expect(sameTemplateNeighbors(weeks, "bo")).toEqual({ previousId: null, nextId: null });
  expect(sameTemplateNeighbors(weeks, "missing")).toEqual({
    previousId: null,
    nextId: null,
  });

  expect(
    stepMemberReportPage({
      pageIds: pages,
      activePageId: "Technique",
      direction: 1,
      previousReportId: null,
      nextReportId: "cy",
    }),
  ).toEqual({ kind: "page", pageId: "要点提炼", edge: "start" });

  expect(
    stepMemberReportPage({
      pageIds: pages,
      activePageId: "要点提炼",
      direction: 1,
      previousReportId: null,
      nextReportId: "cy",
    }),
  ).toEqual({ kind: "report", reportId: "cy", edge: "start" });

  expect(
    stepMemberReportPage({
      pageIds: pages,
      activePageId: "要点提炼",
      direction: 1,
      previousReportId: null,
      nextReportId: null,
    }),
  ).toEqual({ kind: "stay" });

  expect(
    stepMemberReportPage({
      pageIds: pages,
      activePageId: "Technique",
      direction: -1,
      previousReportId: "ann",
      nextReportId: "cy",
    }),
  ).toEqual({ kind: "page", pageId: "Summary", edge: "end" });

  expect(
    stepMemberReportPage({
      pageIds: pages,
      activePageId: "Summary",
      direction: -1,
      previousReportId: "ann",
      nextReportId: null,
    }),
  ).toEqual({ kind: "report", reportId: "ann", edge: "end" });
});

test("one extra wheel gesture advances a single page, and a later gesture can advance again", () => {
  let gesture = initialReadingWheelGesture();
  const step = READING_WHEEL_THRESHOLD / 2;

  let turned = noteReadingWheel(gesture, { deltaY: 200, pinned: false, now: 1_000 });
  gesture = turned.gesture;
  expect(turned.step).toBe(0);

  turned = noteReadingWheel(gesture, { deltaY: step, pinned: true, now: 1_100 });
  gesture = turned.gesture;
  expect(turned.step).toBe(0);

  turned = noteReadingWheel(gesture, { deltaY: step, pinned: true, now: 1_110 });
  gesture = turned.gesture;
  expect(turned.step).toBe(1);

  turned = noteReadingWheel(gesture, { deltaY: 400, pinned: true, now: 1_130 });
  gesture = turned.gesture;
  expect(turned.step).toBe(0);

  turned = noteReadingWheel(gesture, {
    deltaY: READING_WHEEL_THRESHOLD,
    pinned: true,
    now: 1_130 + READING_WHEEL_QUIET_MS + 1,
  });
  gesture = turned.gesture;
  expect(turned.step).toBe(1);
});

test("a wheel that changes direction starts over, and line units count as pixels", () => {
  let gesture = initialReadingWheelGesture();
  let turned = noteReadingWheel(gesture, {
    deltaY: READING_WHEEL_THRESHOLD - 10,
    pinned: true,
    now: 0,
  });
  gesture = turned.gesture;
  turned = noteReadingWheel(gesture, { deltaY: -20, pinned: true, now: 10 });
  gesture = turned.gesture;
  expect(turned.step).toBe(0);
  expect(gesture.carry).toBe(-20);

  expect(readingWheelPixels(5, 1, 400)).toBe(80);
  expect(contentEdgeReached({ scrollTop: 0, clientHeight: 100, contentEnd: 40 })).toEqual({
    atStart: true,
    atEnd: true,
  });
  expect(contentEdgeReached({ scrollTop: 0, clientHeight: 100, contentEnd: 400 })).toEqual({
    atStart: true,
    atEnd: false,
  });
  expect(contentEdgeReached({ scrollTop: 80, clientHeight: 100, contentEnd: 200 })).toEqual({
    atStart: false,
    atEnd: true,
  });
});

test("the landing edge stays until this report clears it", () => {
  stageReadingEdge("cy", "end");
  expect(readReadingEdge("ann")).toBeNull();
  expect(readReadingEdge("cy")).toBe("end");
  expect(readReadingEdge("cy")).toBe("end");
  clearReadingEdge("cy");
  expect(readReadingEdge("cy")).toBeNull();
});

test("a wheel gesture stays armed after the report view remounts", () => {
  resetReadingWheelSession();
  const first = readingWheelSession();
  first.current = { carry: 0, armed: true, lastAt: 50 };
  expect(readingWheelSession().current).toEqual({ carry: 0, armed: true, lastAt: 50 });
  resetReadingWheelSession();
  expect(readingWheelSession().current.armed).toBe(false);
});
