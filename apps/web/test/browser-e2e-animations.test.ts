import { describe, expect, test } from "bun:test";
import { animationsSettled, elementAtRest } from "./helpers/browser-e2e";

class FakeDocumentTimeline {}
class FakeScrollTimeline {}
class FakeViewTimeline {}

type FakeAnimation = {
  timeline: unknown;
  playState: "running" | "finished" | "idle" | "paused";
  effect?: { getComputedTiming: () => { iterations: number } };
};

function evaluateExpression(
  expression: string,
  globals: {
    document: { getAnimations: () => FakeAnimation[] };
    Element?: unknown;
    target?: unknown;
  },
): boolean {
  const fn = new Function(
    "document",
    "DocumentTimeline",
    "Element",
    "__target",
    `return (${expression});`,
  );
  return Boolean(
    fn(globals.document, FakeDocumentTimeline, globals.Element ?? class {}, globals.target),
  );
}

describe("animationsSettled", () => {
  test("ignores running ScrollTimeline and ViewTimeline animations while waiting on running DocumentTimeline animations", () => {
    const scrollOnly = [
      {
        timeline: new FakeScrollTimeline(),
        playState: "running" as const,
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      },
      {
        timeline: new FakeViewTimeline(),
        playState: "running" as const,
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      },
    ];
    expect(
      evaluateExpression(animationsSettled(), { document: { getAnimations: () => scrollOnly } }),
    ).toBe(true);

    const withRealTransition = [
      ...scrollOnly,
      {
        timeline: new FakeDocumentTimeline(),
        playState: "running" as const,
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      },
    ];
    expect(
      evaluateExpression(animationsSettled(), {
        document: { getAnimations: () => withRealTransition },
      }),
    ).toBe(false);

    const finishedTransition = [
      ...scrollOnly,
      {
        timeline: new FakeDocumentTimeline(),
        playState: "finished" as const,
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      },
    ];
    expect(
      evaluateExpression(animationsSettled(), {
        document: { getAnimations: () => finishedTransition },
      }),
    ).toBe(true);
  });

  test("does not skip infinite DocumentTimeline animations unless allowInfinite is explicitly opted in", () => {
    const infinitePulse = [
      {
        timeline: new FakeDocumentTimeline(),
        playState: "running" as const,
        effect: { getComputedTiming: () => ({ iterations: Infinity }) },
      },
    ];
    expect(
      evaluateExpression(animationsSettled(), { document: { getAnimations: () => infinitePulse } }),
    ).toBe(false);
    expect(
      evaluateExpression(animationsSettled({ allowInfinite: true }), {
        document: { getAnimations: () => infinitePulse },
      }),
    ).toBe(true);
  });
});

describe("elementAtRest", () => {
  test("ignores ScrollTimeline on scrollable ancestors while still blocking on DocumentTimeline transitions", () => {
    class FakeElement {
      parentElement: FakeElement | null;
      private animations: FakeAnimation[];
      __reactProps123 = {};
      constructor(animations: FakeAnimation[], parentElement: FakeElement | null = null) {
        this.animations = animations;
        this.parentElement = parentElement;
      }
      getAnimations() {
        return this.animations;
      }
    }

    const scrollAncestor = new FakeElement([
      {
        timeline: new FakeScrollTimeline(),
        playState: "running",
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      },
    ]);
    const restingTarget = new FakeElement([], scrollAncestor);
    expect(
      evaluateExpression(elementAtRest("__target"), {
        document: { getAnimations: () => [] },
        Element: FakeElement,
        target: restingTarget,
      }),
    ).toBe(true);

    const zoomingDialog = new FakeElement(
      [
        {
          timeline: new FakeDocumentTimeline(),
          playState: "running",
          effect: { getComputedTiming: () => ({ iterations: 1 }) },
        },
      ],
      scrollAncestor,
    );
    const buttonInDialog = new FakeElement([], zoomingDialog);
    expect(
      evaluateExpression(elementAtRest("__target"), {
        document: { getAnimations: () => [] },
        Element: FakeElement,
        target: buttonInDialog,
      }),
    ).toBe(false);
  });
});
