import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  appNotice,
  NoticeCardHost,
  shouldStartNoticeCardDrag,
} from "#src/components/ui/notice-card";

afterEach(() => {
  appNotice.dismiss("notice-test");
  appNotice.dismiss("notice-second");
});

test("NoticeCardHost renders an accessible toast region while notices are active, updates in place by id, and unmounts when dismissed", () => {
  expect(renderToStaticMarkup(<NoticeCardHost />)).toBe("");

  appNotice.show({
    id: "notice-test",
    title: "CoForge updated",
    body: "Refresh to use the new version.",
    actions: [
      { label: "Later", onPress: () => undefined },
      { label: "Refresh", onPress: () => undefined },
    ],
  });

  const shownHtml = renderToStaticMarkup(<NoticeCardHost />);
  expect(shownHtml).toContain('role="region"');
  expect(shownHtml).toContain('role="alertdialog"');
  expect(shownHtml).toContain('aria-modal="false"');
  expect(shownHtml).toContain('role="alert"');
  expect(shownHtml).toContain("CoForge updated");
  expect(shownHtml).toContain("Refresh to use the new version.");
  expect(shownHtml).toContain("Later");
  expect(shownHtml).toContain("Refresh");

  appNotice.show({
    id: "notice-test",
    title: "CoForge updated",
    body: "Refreshing may lose unsaved changes.",
    actions: [
      { label: "Later", onPress: () => undefined },
      { label: "Refresh", onPress: () => undefined },
    ],
  });
  const replacedHtml = renderToStaticMarkup(<NoticeCardHost />);
  expect(replacedHtml).toContain("Refreshing may lose unsaved changes.");
  expect(replacedHtml).not.toContain("1 of 2");

  appNotice.show({
    id: "notice-second",
    title: "Another notice",
    body: "Second notice body.",
    actions: [{ label: "Done", onPress: () => undefined }],
  });
  const stackedHtml = renderToStaticMarkup(<NoticeCardHost />);
  expect(stackedHtml).toContain("Another notice");
  expect(stackedHtml).toContain("1 of 2");

  const firstLabelledBy = shownHtml.match(/aria-labelledby="([^"]+)"/)?.[1];
  const firstDescribedBy = shownHtml.match(/aria-describedby="([^"]+)"/)?.[1];
  const secondLabelledBy = stackedHtml.match(/aria-labelledby="([^"]+)"/)?.[1];
  const secondDescribedBy = stackedHtml.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(firstLabelledBy).toBeTruthy();
  expect(firstDescribedBy).toBeTruthy();
  expect(secondLabelledBy).toBeTruthy();
  expect(secondDescribedBy).toBeTruthy();
  expect(secondLabelledBy).not.toBe(firstLabelledBy);
  expect(secondDescribedBy).not.toBe(firstDescribedBy);
  expect(stackedHtml).toContain(`id="${secondLabelledBy}"`);
  expect(stackedHtml).toContain(`id="${secondDescribedBy}"`);

  appNotice.dismiss("notice-second");
  expect(renderToStaticMarkup(<NoticeCardHost />)).toContain("CoForge updated");

  appNotice.dismiss("notice-test");
  expect(renderToStaticMarkup(<NoticeCardHost />)).toBe("");
});

test("shouldStartNoticeCardDrag skips interactive controls and allows dragging from notice text", () => {
  const prevElement = globalThis.Element;
  class FakeElement {
    constructor(private readonly matchedRole: string | null) {}
    closest(selector: string) {
      return this.matchedRole && selector.includes(this.matchedRole) ? this : null;
    }
  }
  globalThis.Element = FakeElement as unknown as typeof Element;
  try {
    expect(shouldStartNoticeCardDrag(new FakeElement("button") as unknown as EventTarget)).toBe(
      false,
    );
    expect(shouldStartNoticeCardDrag(new FakeElement("a") as unknown as EventTarget)).toBe(false);
    expect(
      shouldStartNoticeCardDrag(new FakeElement("[role='button']") as unknown as EventTarget),
    ).toBe(false);
    expect(shouldStartNoticeCardDrag(new FakeElement(null) as unknown as EventTarget)).toBe(true);
    expect(shouldStartNoticeCardDrag(null)).toBe(true);
  } finally {
    globalThis.Element = prevElement;
  }
});
