import { expect, test } from "bun:test";

import {
  alignReportContentToTemplate,
  applyKeyPointPromptText,
  clearReportContent,
  emptyReportContent,
  insertAssistantReportBody,
  isAutoSendCancelled,
  memberReportTitle,
  formatWeeklyReportCompletedAt,
  memberReportMatchesReceived,
  normalizeReportContent,
  orderedReportTabNames,
  publishMemberReportDelivery,
  withReceivedSnapshot,
  removeKeyPointPromptHistoryEntry,
  reportBodyRestoreView,
  reportContentForAuthor,
  reportContentForRecipient,
  reportContentToMarkdown,
  reportTabsEqual,
  switchReportBodyVersion,
  withAssignmentUnread,
  withAutoSendCancelled,
  withWeekSendDismissed,
  withoutWeekSendDismissed,
  isWeekSendDismissed,
  keyPointHistoryIndexOf,
} from "#src/features/records/records-content";

test("emptyReportContent creates named display pages", () => {
  expect(emptyReportContent(["Summary", "Research"])).toEqual({
    tabs: {
      Summary: { markdown: "" },
      Research: { markdown: "" },
    },
    tabOrder: ["Summary", "Research"],
  });
});

test("normalizeReportContent migrates a single markdown document to Summary", () => {
  expect(normalizeReportContent({ markdown: "## Hello\n\n$body$" })).toEqual({
    tabs: { Summary: { markdown: "## Hello\n\n$body$" } },
  });
});

test("normalizeReportContent preserves independent page documents", () => {
  expect(
    normalizeReportContent({
      tabs: {
        Summary: { markdown: "Current work" },
        Research: { markdown: "Open questions" },
      },
    }),
  ).toEqual({
    tabs: {
      Summary: { markdown: "Current work" },
      Research: { markdown: "Open questions" },
    },
  });
});

test("alignReportContentToTemplate adds and removes display pages without losing matching content", () => {
  expect(
    alignReportContentToTemplate(
      { tabs: { Summary: { markdown: "keep" }, Old: { markdown: "remove" } } },
      ["Summary", "Research"],
    ),
  ).toEqual({
    tabs: { Summary: { markdown: "keep" }, Research: { markdown: "" } },
    tabOrder: ["Summary", "Research"],
  });
});

test("template alignment and clearing keep the assistant original", () => {
  const assistantDraft = { tabs: { Summary: { markdown: "assistant" } } };
  const content = {
    tabs: { Summary: { markdown: "author" }, Old: { markdown: "remove" } },
    assistantDraft,
  };
  expect(alignReportContentToTemplate(content, ["Summary", "Research"]).assistantDraft).toEqual(
    assistantDraft,
  );
  expect(clearReportContent(content).assistantDraft).toEqual(assistantDraft);
  expect(clearReportContent(content).tabs).toEqual({});
});

test("clearReportContent removes every heading level", () => {
  expect(
    clearReportContent({
      tabs: {
        Summary: { markdown: "## Work Summary\n\none" },
        Research: { markdown: "## New paper\n\ntwo" },
      },
      assignment: { unread: true },
    }),
  ).toEqual({
    tabs: {},
    assignment: { unread: true },
  });
});

test("a member report cannot send until its body differs from the one received", () => {
  const received = withReceivedSnapshot({
    tabs: { Summary: { markdown: "## Work Summary\n\n" } },
  });
  expect(memberReportMatchesReceived(received)).toBe(true);
  expect(
    memberReportMatchesReceived({
      ...received,
      tabs: { Summary: { markdown: "## Work Summary\n\nshipped the parser" } },
    }),
  ).toBe(false);
  expect(normalizeReportContent(received).received).toEqual(received.received);
});

test("normalizeReportContent keeps a report that has no headings", () => {
  expect(normalizeReportContent({ tabs: {}, assignment: { unread: true } })).toEqual({
    tabs: {},
    assignment: { unread: true },
  });
});

test("normalizeReportContent preserves assignment unread metadata", () => {
  expect(
    normalizeReportContent({
      tabs: { Summary: { markdown: "body" } },
      assignment: { unread: true },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "body" } },
    assignment: { unread: true },
  });
});

test("withAssignmentUnread toggles inbox unread without dropping pages", () => {
  expect(withAssignmentUnread({ tabs: { Summary: { markdown: "x" } } }, true)).toEqual({
    tabs: { Summary: { markdown: "x" } },
    assignment: { unread: true },
  });
  expect(
    withAssignmentUnread(
      { tabs: { Summary: { markdown: "x" } }, assignment: { unread: true } },
      false,
    ),
  ).toEqual({
    tabs: { Summary: { markdown: "x" } },
    assignment: { unread: false },
  });
});

test("memberReportTitle uses the member name, year, and week", () => {
  expect(memberReportTitle("李四", 2026, 37)).toBe("李四 2026 W37 工作周报");
});

test("memberReportTitle bidi-isolates RTL member names so year and week stay ordered", () => {
  expect(memberReportTitle("نور الهدى عبد الرحمن", 2026, 46)).toBe(
    "\u2068نور الهدى عبد الرحمن\u2069 2026 W46 工作周报",
  );
  expect(memberReportTitle("דוד כהן", 2026, 46)).toBe("\u2068דוד כהן\u2069 2026 W46 工作周报");
});

test("reportContentToMarkdown joins tabs as headings", () => {
  expect(
    reportContentToMarkdown({
      tabs: {
        Summary: { markdown: "- a" },
        Research: { markdown: "body" },
      },
    }),
  ).toBe("# Summary\n\n- a\n\n# Research\n\nbody");
});

test("reportTabsEqual ignores assignment and schedule metadata", () => {
  expect(
    reportTabsEqual(
      { tabs: { Summary: { markdown: "a" } }, assignment: { unread: true } },
      {
        tabs: { Summary: { markdown: "a" } },
        schedule: { cancelledYear: 2026, cancelledWeek: 38 },
      },
    ),
  ).toBe(true);
  expect(
    reportTabsEqual(
      { tabs: { Summary: { markdown: "a" } } },
      { tabs: { Summary: { markdown: "b" } } },
    ),
  ).toBe(false);
});

test("withAutoSendCancelled stamps the ISO week and survives normalize", () => {
  const next = withAutoSendCancelled({ tabs: { Summary: { markdown: "body" } } }, 2026, 38);
  expect(isAutoSendCancelled(next, 2026, 38)).toBe(true);
  expect(isAutoSendCancelled(next, 2026, 37)).toBe(false);
  expect(normalizeReportContent(next).schedule).toEqual({ cancelledYear: 2026, cancelledWeek: 38 });
});

test("withoutWeekSendDismissed clears this week's cancel stamp", () => {
  const dismissed = withWeekSendDismissed({ tabs: { Summary: { markdown: "body" } } }, 2026, 40);
  const cleared = withoutWeekSendDismissed(dismissed, 2026, 40);
  expect(isWeekSendDismissed(cleared, 2026, 40)).toBe(false);
  expect(isAutoSendCancelled(cleared, 2026, 40)).toBe(false);
  expect(cleared.tabs?.Summary?.markdown).toBe("body");
  expect(withoutWeekSendDismissed(dismissed, 2026, 39).schedule?.dismissSend).toBe(true);
});

test("withWeekSendDismissed blocks the week and survives normalize", () => {
  const next = withWeekSendDismissed({ tabs: { Summary: { markdown: "body" } } }, 2026, 38);
  expect(isWeekSendDismissed(next, 2026, 38)).toBe(true);
  expect(isAutoSendCancelled(next, 2026, 38)).toBe(true);
  expect(isWeekSendDismissed(next, 2026, 37)).toBe(false);
  expect(normalizeReportContent(next).schedule).toEqual({
    cancelledYear: 2026,
    cancelledWeek: 38,
    dismissSend: true,
  });
});

test("normalizeReportContent drops legacy highlightPrompt without preserving it", () => {
  expect(
    normalizeReportContent({
      tabs: { Summary: { markdown: "" } },
      highlightPrompt: {
        text: "current",
        history: [{ text: "old", updatedAt: "2026-09-12T03:23:34.000Z" }],
      },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "" } },
  });
});

test("normalizeReportContent preserves keyPointPrompts and keyPointExtraction", () => {
  expect(
    normalizeReportContent({
      tabs: { Summary: { markdown: "body" } },
      keyPointPrompts: {
        team: { text: "team prompt", updatedAt: "2026-09-12T03:23:34.000Z", history: [] },
        personal: {
          text: "personal prompt",
          history: [{ text: "older", updatedAt: "2026-09-11T00:00:00.000Z" }],
        },
      },
      keyPointExtraction: {
        status: "ready",
        promptSnapshot: "personal prompt",
        markdown: "- item",
        generatedAt: "2026-09-18T08:00:00.000Z",
      },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "body" } },
    keyPointPrompts: {
      team: { text: "team prompt", updatedAt: "2026-09-12T03:23:34.000Z", history: [] },
      personal: {
        text: "personal prompt",
        history: [{ text: "older", updatedAt: "2026-09-11T00:00:00.000Z" }],
      },
    },
    keyPointExtraction: {
      status: "ready",
      promptSnapshot: "personal prompt",
      markdown: "- item",
      generatedAt: "2026-09-18T08:00:00.000Z",
    },
  });
});

test("applyKeyPointPromptText pushes the previous text onto history when it changes", () => {
  const first = applyKeyPointPromptText(undefined, "v1", new Date("2026-09-12T03:23:34.000Z"));
  expect(first).toEqual({
    text: "v1",
    updatedAt: "2026-09-12T03:23:34.000Z",
    history: [],
  });
  const second = applyKeyPointPromptText(first, "v2", new Date("2026-09-13T01:00:00.000Z"));
  expect(second).toEqual({
    text: "v2",
    updatedAt: "2026-09-13T01:00:00.000Z",
    history: [{ text: "v1", updatedAt: "2026-09-12T03:23:34.000Z" }],
  });
});

test("removeKeyPointPromptHistoryEntry drops one history row by index", () => {
  const state = {
    text: "current",
    updatedAt: "2026-09-18T00:00:00.000Z",
    history: [
      { text: "old-a", updatedAt: "2026-09-17T00:00:00.000Z" },
      { text: "old-b", updatedAt: "2026-09-16T00:00:00.000Z" },
    ],
  };
  expect(removeKeyPointPromptHistoryEntry(state, 0).history).toEqual([
    { text: "old-b", updatedAt: "2026-09-16T00:00:00.000Z" },
  ]);
});

test("formatWeeklyReportCompletedAt uses dotted Asia/Shanghai wall time", () => {
  expect(formatWeeklyReportCompletedAt("2026-09-03T02:34:12.000Z")).toBe("2026.09.03 10:34:12");
});

test("a captured key-point history entry resolves to its position in the latest history", () => {
  const older = { text: "older prompt", updatedAt: "2026-09-01T00:00:00.000Z" };
  const newer = { text: "newer prompt", updatedAt: "2026-09-02T00:00:00.000Z" };
  const inserted = { text: "inserted prompt", updatedAt: "2026-09-03T00:00:00.000Z" };

  expect(keyPointHistoryIndexOf([newer, older], older)).toBe(1);
  expect(keyPointHistoryIndexOf([inserted, newer, older], older)).toBe(2);
  expect(keyPointHistoryIndexOf([newer], older)).toBe(-1);
  expect(keyPointHistoryIndexOf([{ ...older, text: "edited prompt" }], older)).toBe(-1);
});

const messageId = "33333333-3333-4333-8333-333333333333";

test("an assistant insert keeps the previous body and shows the new one", () => {
  const stored = { tabs: { Progress: { markdown: "上一版" } } };
  const inserted = insertAssistantReportBody(
    stored,
    { tabs: { Progress: { markdown: "最新版" } } },
    messageId,
  );
  expect(inserted.tabs).toEqual({ Progress: { markdown: "最新版" } });
  expect(inserted.bodyRestore).toEqual({
    sourceMessageId: messageId,
    revision: 1,
    showing: "latest",
    previous: { tabs: { Progress: { markdown: "上一版" } } },
    latest: { tabs: { Progress: { markdown: "最新版" } } },
  });
  expect(inserted.assistantDraft).toEqual({
    tabs: { Progress: { markdown: "最新版" } },
  });
  expect(reportBodyRestoreView(inserted)).toEqual({
    sourceMessageId: messageId,
    revision: 1,
    showing: "latest",
  });
  expect(reportContentForAuthor(inserted).bodyRestore).toBeUndefined();
  expect(reportContentForRecipient(inserted).bodyRestore).toBeUndefined();
});

test("the same assistant message does not replace the stored pair", () => {
  const first = insertAssistantReportBody(
    { tabs: { Progress: { markdown: "上一版" } } },
    { tabs: { Progress: { markdown: "最新版" } } },
    messageId,
  );
  const again = insertAssistantReportBody(
    first,
    { tabs: { Progress: { markdown: "另一份" } } },
    messageId,
  );
  expect(again).toEqual(first);
});

test("switching versions keeps edits on the side you leave", () => {
  const inserted = insertAssistantReportBody(
    { tabs: { Progress: { markdown: "上一版" } } },
    { tabs: { Progress: { markdown: "最新版" } } },
    messageId,
  );
  const editedLatest = {
    ...inserted,
    tabs: { Progress: { markdown: "最新版改过" } },
  };
  const previous = switchReportBodyVersion(editedLatest);
  expect(previous.tabs).toEqual({ Progress: { markdown: "上一版" } });
  expect(previous.bodyRestore?.showing).toBe("previous");
  expect(previous.bodyRestore?.latest.tabs).toEqual({ Progress: { markdown: "最新版改过" } });
  expect(previous.assistantDraft).toEqual(inserted.assistantDraft);

  const editedPrevious = {
    ...previous,
    tabs: { Progress: { markdown: "上一版改过" } },
  };
  const restored = switchReportBodyVersion(editedPrevious);
  expect(restored.tabs).toEqual({ Progress: { markdown: "最新版改过" } });
  expect(restored.bodyRestore?.showing).toBe("latest");
  expect(restored.bodyRestore?.previous.tabs).toEqual({ Progress: { markdown: "上一版改过" } });
  expect(restored.bodyRestore?.revision).toBe(3);
});

test("a later assistant insert replaces the pair with the body on screen", () => {
  const first = insertAssistantReportBody(
    { tabs: { Progress: { markdown: "最初" } } },
    { tabs: { Progress: { markdown: "第一次整理" } } },
    messageId,
  );
  const next = insertAssistantReportBody(
    { ...first, tabs: { Progress: { markdown: "手改后" } } },
    { tabs: { Progress: { markdown: "第二次整理" } } },
    "44444444-4444-4444-8444-444444444444",
  );
  expect(next.tabs).toEqual({ Progress: { markdown: "第二次整理" } });
  expect(next.bodyRestore?.previous.tabs).toEqual({ Progress: { markdown: "手改后" } });
  expect(next.bodyRestore?.latest.tabs).toEqual({ Progress: { markdown: "第二次整理" } });
  expect(next.bodyRestore?.showing).toBe("latest");
  expect(next.bodyRestore?.revision).toBe(2);
});

test("tabOrder preserves multi-tab order across jsonb key-length reordering", () => {
  const jsonbReordered = {
    tabs: {
      A: { markdown: "third" },
      下周计划: { markdown: "second" },
      本周工作总结: { markdown: "first" },
    },
    tabOrder: ["本周工作总结", "下周计划", "A"],
  };
  const normalized = normalizeReportContent(jsonbReordered);
  expect(normalized.tabOrder).toEqual(["本周工作总结", "下周计划", "A"]);
  expect(orderedReportTabNames(normalized)).toEqual(["本周工作总结", "下周计划", "A"]);
  expect(Object.keys(normalized.tabs ?? {})).toEqual(["本周工作总结", "下周计划", "A"]);
  expect(reportContentToMarkdown(jsonbReordered)).toBe(
    "# 本周工作总结\n\nfirst\n\n# 下周计划\n\nsecond\n\n# A\n\nthird",
  );
});

test("tabOrder filters removed tabs, appends unindexed tabs, and stays optional for legacy rows", () => {
  const legacy = normalizeReportContent({
    tabs: {
      Summary: { markdown: "one" },
      Research: { markdown: "two" },
    },
  });
  expect(legacy.tabOrder).toBeUndefined();
  expect(orderedReportTabNames(legacy)).toEqual(["Summary", "Research"]);

  const partial = normalizeReportContent({
    tabs: {
      A: { markdown: "last" },
      Summary: { markdown: "first" },
      Extra: { markdown: "appended" },
    },
    tabOrder: ["Ghost", "Summary", "Summary", "A"],
  });
  expect(partial.tabOrder).toEqual(["Summary", "A", "Extra"]);
  expect(orderedReportTabNames(partial)).toEqual(["Summary", "A", "Extra"]);
});

test("reportTabsEqual and delivery snapshots preserve tabOrder", () => {
  const firstOrder = {
    tabs: { A: { markdown: "x" }, Summary: { markdown: "y" } },
    tabOrder: ["Summary", "A"],
  };
  const movedOrder = {
    tabs: { A: { markdown: "x" }, Summary: { markdown: "y" } },
    tabOrder: ["A", "Summary"],
  };
  expect(reportTabsEqual(firstOrder, movedOrder)).toBe(false);

  const delivered = publishMemberReportDelivery(firstOrder);
  const recipientAfterJsonb = reportContentForRecipient({
    tabs: { A: { markdown: "draft" }, Summary: { markdown: "draft" } },
    delivered: {
      tabs: { A: { markdown: "x" }, Summary: { markdown: "y" } },
      tabOrder: delivered.delivered?.tabOrder,
    },
  });
  expect(orderedReportTabNames(recipientAfterJsonb)).toEqual(["Summary", "A"]);

  const fromDimensions = emptyReportContent(["本周工作总结", "下周计划", "A"]);
  const roundTripped = normalizeReportContent({
    tabs: {
      A: fromDimensions.tabs!.A!,
      下周计划: fromDimensions.tabs!.下周计划!,
      本周工作总结: fromDimensions.tabs!.本周工作总结!,
    },
    tabOrder: fromDimensions.tabOrder,
  });
  expect(orderedReportTabNames(roundTripped)).toEqual(["本周工作总结", "下周计划", "A"]);
});
