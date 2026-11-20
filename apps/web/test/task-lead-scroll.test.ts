import { describe, expect, test } from "bun:test";

import {
  findScrollContainer,
  isLeadScrolledOut,
  scrollContainerToTop,
} from "#src/features/tasks/task-lead-scroll";

type FakeNode = {
  parentElement: FakeNode | null;
  overflowY: string;
};

describe("findScrollContainer", () => {
  test("returns the nearest scrollable ancestor inside the boundary", () => {
    const outer: FakeNode = { parentElement: null, overflowY: "auto" };
    const boundary: FakeNode = { parentElement: outer, overflowY: "hidden" };
    const scroller: FakeNode = { parentElement: boundary, overflowY: "auto" };
    const wrapper: FakeNode = { parentElement: scroller, overflowY: "visible" };
    const title: FakeNode = { parentElement: wrapper, overflowY: "visible" };

    const found = findScrollContainer(title, boundary, (node) => node.overflowY);
    expect(found).toBe(scroller);
  });

  test("supports scroll and overlay overflow values", () => {
    const boundary: FakeNode = { parentElement: null, overflowY: "hidden" };
    const scrollNode: FakeNode = { parentElement: boundary, overflowY: "scroll" };
    const overlayNode: FakeNode = { parentElement: boundary, overflowY: "overlay" };
    const childA: FakeNode = { parentElement: scrollNode, overflowY: "visible" };
    const childB: FakeNode = { parentElement: overlayNode, overflowY: "clip" };

    expect(findScrollContainer(childA, boundary, (node) => node.overflowY)).toBe(scrollNode);
    expect(findScrollContainer(childB, boundary, (node) => node.overflowY)).toBe(overlayNode);
  });

  test("stops at boundary and does not escape to an outer scroller", () => {
    const documentScroller: FakeNode = { parentElement: null, overflowY: "auto" };
    const boundary: FakeNode = { parentElement: documentScroller, overflowY: "hidden" };
    const wrapper: FakeNode = { parentElement: boundary, overflowY: "visible" };
    const title: FakeNode = { parentElement: wrapper, overflowY: "visible" };

    const found = findScrollContainer(title, boundary, (node) => node.overflowY);
    expect(found).toBeNull();
  });
});

describe("isLeadScrolledOut", () => {
  test("returns false while title is intersecting", () => {
    expect(
      isLeadScrolledOut(
        {
          isIntersecting: true,
          boundingClientRect: { bottom: 40 },
          rootBounds: { top: 20 },
        },
        120,
      ),
    ).toBe(false);
  });

  test("returns false at scrollTop 0 even if observer reports non-intersecting", () => {
    expect(
      isLeadScrolledOut(
        {
          isIntersecting: false,
          boundingClientRect: { bottom: 0 },
          rootBounds: { top: 20 },
        },
        0,
      ),
    ).toBe(false);
  });

  test("returns false when element is below root top rather than scrolled past it", () => {
    expect(
      isLeadScrolledOut(
        {
          isIntersecting: false,
          boundingClientRect: { bottom: 600 },
          rootBounds: { top: 100 },
        },
        50,
      ),
    ).toBe(false);
  });

  test("returns true when scrolled past the top of the scroll container", () => {
    expect(
      isLeadScrolledOut(
        {
          isIntersecting: false,
          boundingClientRect: { bottom: 100 },
          rootBounds: { top: 100 },
        },
        180,
      ),
    ).toBe(true);
  });

  test("returns true when rootBounds is null and scrollTop is positive", () => {
    expect(
      isLeadScrolledOut(
        {
          isIntersecting: false,
          boundingClientRect: { bottom: -10 },
          rootBounds: null,
        },
        80,
      ),
    ).toBe(true);
  });
});

describe("scrollContainerToTop", () => {
  test("uses smooth scrolling when reduced motion is off", () => {
    const calls: ScrollToOptions[] = [];
    scrollContainerToTop(
      {
        scrollTo: (options: ScrollToOptions) => {
          calls.push(options);
        },
      },
      false,
    );
    expect(calls).toEqual([{ top: 0, behavior: "smooth" }]);
  });

  test("uses auto scrolling when reduced motion is enabled", () => {
    const calls: ScrollToOptions[] = [];
    scrollContainerToTop(
      {
        scrollTo: (options: ScrollToOptions) => {
          calls.push(options);
        },
      },
      true,
    );
    expect(calls).toEqual([{ top: 0, behavior: "auto" }]);
  });
});
