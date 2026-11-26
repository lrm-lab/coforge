import { describe, expect, test } from "bun:test";
import { chipControl } from "#src/lib/chip-control";
import {
  captureTaskPopupFocusTarget,
  focusRestoredTarget,
  resolveTaskDetailFocusFallback,
  resolveTaskPopupRestoreFocus,
} from "#src/features/tasks/task-popup-profile";

class FakeElement {
  isConnected: boolean;
  inert: boolean;
  private readonly throwOnFocus: boolean;
  private readonly attributes = new Map<string, string>();
  focused = 0;
  sawSkipFocusPreviewWhileFocusing = false;
  lastFocusOptions: FocusOptions | undefined;

  constructor(
    private readonly selectors: {
      dialog?: FakeElement | null;
      panel?: FakeElement | null;
      heading?: FakeElement | null;
      isConnected?: boolean;
      inert?: boolean;
      throwOnFocus?: boolean;
    } = {},
  ) {
    this.isConnected = selectors.isConnected ?? true;
    this.inert = selectors.inert ?? false;
    this.throwOnFocus = selectors.throwOnFocus ?? false;
  }

  closest(selector: string) {
    if (selector === '[role="dialog"]') return this.selectors.dialog ?? null;
    if (selector === "[data-task-detail]") return this.selectors.panel ?? null;
    if (selector === "[inert]") return this.inert ? this : null;
    return null;
  }

  querySelector(selector: string) {
    if (selector === "[data-task-detail-heading]") return this.selectors.heading ?? null;
    return null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  focus(options?: FocusOptions) {
    this.focused += 1;
    this.lastFocusOptions = options;
    this.sawSkipFocusPreviewWhileFocusing = this.attributes.has("data-skip-focus-preview");
    if (this.throwOnFocus) {
      throw new Error("focus failed");
    }
  }
}

function fakeDocument(
  options: {
    body?: FakeElement;
    documentElement?: FakeElement;
    panels?: FakeElement[];
    sheets?: FakeElement[];
  } = {},
) {
  const toList = (items: FakeElement[]) => ({
    length: items.length,
    item: (index: number) => items[index] ?? null,
  });
  return {
    body: (options.body ?? new FakeElement()) as unknown as HTMLElement,
    documentElement: (options.documentElement ?? new FakeElement()) as unknown as HTMLElement,
    querySelectorAll: (selector: string) => {
      if (selector === "[data-task-detail]") return toList(options.panels ?? []);
      if (selector === '[data-detent-sheet] [role="dialog"]') return toList(options.sheets ?? []);
      return toList([]);
    },
  } as unknown as Pick<Document, "body" | "documentElement" | "querySelectorAll">;
}

describe("task popup focus restoration", () => {
  test("prefers exact trigger in desktop split and dialog, then falls back cleanly", () => {
    const previousHtmlElement = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
    try {
      const dialog = new FakeElement();
      const triggerInDialog = new FakeElement({ dialog });
      const dialogDoc = fakeDocument();
      const dialogSnapshot = captureTaskPopupFocusTarget(
        triggerInDialog as unknown as Element,
        dialogDoc,
      );
      expect(dialogSnapshot.trigger).toBe(triggerInDialog as unknown as HTMLElement);
      expect(dialogSnapshot.fallback).toBe(dialog as unknown as HTMLElement);
      expect(resolveTaskPopupRestoreFocus(dialogSnapshot, dialogDoc)).toBe(
        triggerInDialog as unknown as HTMLElement,
      );

      const heading = new FakeElement();
      const splitPanel = new FakeElement({ heading });
      const triggerInSplit = new FakeElement({ panel: splitPanel });
      const splitDoc = fakeDocument({ panels: [splitPanel] });
      const splitSnapshot = captureTaskPopupFocusTarget(
        triggerInSplit as unknown as Element,
        splitDoc,
      );
      expect(splitSnapshot.trigger).toBe(triggerInSplit as unknown as HTMLElement);
      expect(splitSnapshot.fallback).toBe(heading as unknown as HTMLElement);
      expect(resolveTaskPopupRestoreFocus(splitSnapshot, splitDoc)).toBe(
        triggerInSplit as unknown as HTMLElement,
      );

      triggerInSplit.isConnected = false;
      expect(resolveTaskPopupRestoreFocus(splitSnapshot, splitDoc)).toBe(
        heading as unknown as HTMLElement,
      );

      triggerInDialog.isConnected = false;
      expect(resolveTaskPopupRestoreFocus(dialogSnapshot, dialogDoc)).toBe(
        dialog as unknown as HTMLElement,
      );
    } finally {
      globalThis.HTMLElement = previousHtmlElement;
    }
  });

  test("falls back when exact trigger is inert or both snapshot nodes detach", () => {
    const previousHtmlElement = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
    try {
      const panelWithoutHeading = new FakeElement();
      const inertTrigger = new FakeElement({ panel: panelWithoutHeading, inert: true });
      const inertSnapshot = captureTaskPopupFocusTarget(inertTrigger as unknown as Element);
      expect(resolveTaskPopupRestoreFocus(inertSnapshot)).toBe(
        panelWithoutHeading as unknown as HTMLElement,
      );

      const detachedHeading = new FakeElement({ isConnected: false });
      const detachedTrigger = new FakeElement({
        panel: new FakeElement({ heading: detachedHeading, isConnected: false }),
        isConnected: false,
      });
      const detachedSnapshot = {
        trigger: detachedTrigger as unknown as HTMLElement,
        fallback: detachedHeading as unknown as HTMLElement,
      };

      const liveHeading = new FakeElement();
      const livePanel = new FakeElement({ heading: liveHeading });
      expect(
        resolveTaskPopupRestoreFocus(detachedSnapshot, fakeDocument({ panels: [livePanel] })),
      ).toBe(liveHeading as unknown as HTMLElement);

      const liveSheetDialog = new FakeElement();
      expect(
        resolveTaskPopupRestoreFocus(detachedSnapshot, fakeDocument({ sheets: [liveSheetDialog] })),
      ).toBe(liveSheetDialog as unknown as HTMLElement);
    } finally {
      globalThis.HTMLElement = previousHtmlElement;
    }
  });

  test("ignores body, documentElement, outside elements, and unavailable fallbacks", () => {
    const previousHtmlElement = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
    try {
      const heading = new FakeElement();
      const panel = new FakeElement({ heading });
      const doc = fakeDocument({ panels: [panel] });

      const bodySnapshot = captureTaskPopupFocusTarget(doc.body, doc);
      expect(bodySnapshot.trigger).toBeNull();
      expect(bodySnapshot.fallback).toBe(heading as unknown as HTMLElement);
      expect(resolveTaskPopupRestoreFocus(bodySnapshot, doc)).toBe(
        heading as unknown as HTMLElement,
      );

      const rootSnapshot = captureTaskPopupFocusTarget(doc.documentElement, doc);
      expect(rootSnapshot.trigger).toBeNull();
      expect(resolveTaskPopupRestoreFocus(rootSnapshot, doc)).toBe(
        heading as unknown as HTMLElement,
      );

      const outsideElement = new FakeElement();
      const outsideSnapshot = captureTaskPopupFocusTarget(
        outsideElement as unknown as Element,
        fakeDocument(),
      );
      expect(outsideSnapshot.trigger).toBeNull();
      expect(outsideSnapshot.fallback).toBeNull();
      expect(resolveTaskPopupRestoreFocus(outsideSnapshot, fakeDocument())).toBeNull();

      const inertSheet = new FakeElement({ inert: true });
      expect(resolveTaskDetailFocusFallback(null, fakeDocument())).toBeNull();
      expect(resolveTaskPopupRestoreFocus(null, fakeDocument({ sheets: [inertSheet] }))).toBeNull();
    } finally {
      globalThis.HTMLElement = previousHtmlElement;
    }
  });

  test("focusRestoredTarget guards hover-preview focus and always clears its attribute", () => {
    const target = new FakeElement();
    focusRestoredTarget(target as unknown as HTMLElement);
    expect(target.focused).toBe(1);
    expect(target.lastFocusOptions).toEqual({ preventScroll: true });
    expect(target.sawSkipFocusPreviewWhileFocusing).toBe(true);
    expect(target.hasAttribute("data-skip-focus-preview")).toBe(false);

    const throwingTarget = new FakeElement({ throwOnFocus: true });
    expect(() => focusRestoredTarget(throwingTarget as unknown as HTMLElement)).toThrow(
      "focus failed",
    );
    expect(throwingTarget.sawSkipFocusPreviewWhileFocusing).toBe(true);
    expect(throwingTarget.hasAttribute("data-skip-focus-preview")).toBe(false);
  });
});

describe("chipControl keyboard propagation", () => {
  test("activates on Enter/Space and lets Escape pass through without stopping propagation", () => {
    let opened = 0;
    const control = chipControl(() => {
      opened += 1;
    });
    expect(control).toBeDefined();

    let escapePrevented = false;
    let escapeStopped = false;
    control?.onKeyDown({
      key: "Escape",
      preventDefault() {
        escapePrevented = true;
      },
      stopPropagation() {
        escapeStopped = true;
      },
    } as unknown as Parameters<NonNullable<typeof control>["onKeyDown"]>[0]);
    expect(opened).toBe(0);
    expect(escapePrevented).toBe(false);
    expect(escapeStopped).toBe(false);

    let enterPrevented = false;
    control?.onKeyDown({
      key: "Enter",
      preventDefault() {
        enterPrevented = true;
      },
    } as unknown as Parameters<NonNullable<typeof control>["onKeyDown"]>[0]);
    expect(opened).toBe(1);
    expect(enterPrevented).toBe(true);
  });
});
