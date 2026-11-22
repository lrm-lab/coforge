import {
  parseAssignmentMeta,
  parseScheduleMeta,
  type ReportAssignmentMeta,
  type ReportScheduleMeta,
} from "./records-format-meta";
import {
  parseKeyPointExtraction,
  parseKeyPointPrompts,
  type KeyPointExtractionMeta,
  type KeyPointPromptsMeta,
} from "./records-key-points";

export {
  formatRecipientSummary,
  formatWeeklyReportCompletedAt,
  hourlySendTimes,
  isHourlySendTime,
  isValidIsoWeekNumber,
  isValidTemplateName,
  memberReportTitle,
  memberWeekTitle,
  type ReportAssignmentMeta,
  type ReportScheduleMeta,
} from "./records-format-meta";

export {
  applyKeyPointPromptText,
  DEFAULT_PERSONAL_KEY_POINT_PROMPT,
  DEFAULT_TEAM_KEY_POINT_PROMPT,
  emptyKeyPointPrompt,
  emptyKeyPointPrompts,
  KEY_POINT_PROMPT_HISTORY_LIMIT,
  keyPointHistoryIndexOf,
  removeKeyPointPromptHistoryEntry,
  type KeyPointExtractionMeta,
  type KeyPointExtractionStatus,
  type KeyPointPromptHistoryEntry,
  type KeyPointPromptsMeta,
  type KeyPointPromptState,
} from "./records-key-points";

export {
  isAssignmentUnread,
  isAutoSendCancelled,
  isWeekSendDismissed,
  withAssignmentUnread,
  withAutoSendCancelled,
  withKeyPointExtraction,
  withKeyPointPrompts,
  withoutWeekSendDismissed,
  withWeekSendDismissed,
} from "./records-schedule-state";

export type ReportTab = {
  markdown: string;
};

export type ReportBodySnapshot = {
  tabs: Record<string, ReportTab>;
  tabOrder?: string[];
};

export type ReportContent = {
  tabs?: Record<string, ReportTab>;
  tabOrder?: string[];
  markdown?: string;
  assignment?: ReportAssignmentMeta;
  schedule?: ReportScheduleMeta;
  keyPointPrompts?: KeyPointPromptsMeta;
  keyPointExtraction?: KeyPointExtractionMeta;
  delivered?: ReportBodySnapshot;
  assistantDraft?: ReportBodySnapshot;
  received?: ReportBodySnapshot;
  bodyRestore?: ReportBodyRestore;
};

export type ReportBodyRestore = {
  sourceMessageId: string;
  revision: number;
  showing: "latest" | "previous";
  previous: ReportBodySnapshot;
  latest: ReportBodySnapshot;
};

export type ReportBodyRestoreView = {
  sourceMessageId: string;
  revision: number;
  showing: "latest" | "previous";
};

type LegacyOutlineNode = {
  text?: unknown;
  children?: LegacyOutlineNode[];
};

type LegacySection = {
  title?: unknown;
  markdown?: unknown;
  roots?: LegacyOutlineNode[];
};

function newTabName() {
  return "Summary";
}

function resolveTabNames(tabs: Record<string, ReportTab>, rawOrder?: readonly unknown[]): string[] {
  const keys = Object.keys(tabs);
  if (!Array.isArray(rawOrder)) return keys;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of rawOrder) {
    if (typeof item !== "string" || seen.has(item) || !Object.hasOwn(tabs, item)) continue;
    seen.add(item);
    ordered.push(item);
  }
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

function reorderTabsRecord(
  tabs: Record<string, ReportTab>,
  names: readonly string[],
): Record<string, ReportTab> {
  return Object.fromEntries(names.map((name) => [name, tabs[name]!]));
}

export function orderedReportTabNames(content: ReportContent): string[] {
  if (content.tabs) return resolveTabNames(content.tabs, content.tabOrder);
  return [newTabName()];
}

export function orderedReportTabEntries(content: ReportContent): [string, ReportTab][] {
  if (content.tabs) {
    const tabs = content.tabs;
    return resolveTabNames(tabs, content.tabOrder).map((name) => [name, tabs[name]!]);
  }
  const fallbackName = newTabName();
  return [[fallbackName, { markdown: content.markdown ?? "" }]];
}

function parseReportTabs(value: unknown): Record<string, ReportTab> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tabs = Object.fromEntries(
    Object.entries(value as Record<string, { markdown?: unknown; sections?: LegacySection[] }>).map(
      ([name, tab]) => [
        name,
        {
          markdown:
            typeof tab?.markdown === "string"
              ? tab.markdown
              : legacySectionsToMarkdown(tab?.sections ?? []),
        },
      ],
    ),
  );
  return Object.keys(tabs).length > 0 ? tabs : undefined;
}

function parseBodySnapshot(value: unknown, allowEmpty: boolean): ReportBodySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { tabs?: unknown; tabOrder?: unknown };
  const raw = row.tabs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (Object.keys(raw).length === 0) return allowEmpty ? { tabs: {} } : undefined;
  const tabs = parseReportTabs(raw);
  if (!tabs) return undefined;
  if (Array.isArray(row.tabOrder)) {
    const tabOrder = resolveTabNames(tabs, row.tabOrder);
    return {
      tabs: reorderTabsRecord(tabs, tabOrder),
      ...(tabOrder.length > 0 ? { tabOrder } : {}),
    };
  }
  return { tabs };
}

function withDeliveredBody(
  content: ReportContent,
  delivered: ReportBodySnapshot | undefined,
): ReportContent {
  if (!delivered) return content;
  return { ...content, delivered };
}

function withAssistantDraft(
  content: ReportContent,
  assistantDraft: ReportBodySnapshot | undefined,
): ReportContent {
  if (!assistantDraft) return content;
  return { ...content, assistantDraft };
}

function withBodyRestore(
  content: ReportContent,
  bodyRestore: ReportBodyRestore | undefined,
): ReportContent {
  if (!bodyRestore) return content;
  return { ...content, bodyRestore };
}

export function withOptionalMeta(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
  schedule: ReportScheduleMeta | undefined,
  keyPointPrompts?: KeyPointPromptsMeta | undefined,
  keyPointExtraction?: KeyPointExtractionMeta | undefined,
): ReportContent {
  return {
    ...content,
    ...(assignment ? { assignment } : {}),
    ...(schedule ? { schedule } : {}),
    ...(keyPointPrompts ? { keyPointPrompts } : {}),
    ...(keyPointExtraction ? { keyPointExtraction } : {}),
  };
}

function legacyOutlineToMarkdown(nodes: LegacyOutlineNode[], depth = 0): string {
  return nodes
    .flatMap((node) => {
      const text = typeof node.text === "string" ? node.text.trimEnd() : "";
      const line = text || (node.children?.length ?? 0) > 0 ? `${"  ".repeat(depth)}- ${text}` : "";
      const children = node.children?.length
        ? legacyOutlineToMarkdown(node.children, depth + 1)
        : "";
      return [line, children].filter(Boolean);
    })
    .join("\n");
}

function legacySectionsToMarkdown(sections: LegacySection[]): string {
  return sections
    .flatMap((section) => {
      const title = typeof section.title === "string" ? section.title.trim() : "";
      const body =
        typeof section.markdown === "string" && section.markdown.length > 0
          ? section.markdown
          : legacyOutlineToMarkdown(section.roots ?? []);
      return [title ? `## ${title}` : "", body].filter(Boolean);
    })
    .join("\n\n")
    .trim();
}

export function emptyReportContent(dimensions: string[] = []): ReportContent {
  const names = dimensions.map((name) => name.trim()).filter(Boolean);
  const uniqueNames = [...new Set(names.length > 0 ? names : [newTabName()])];
  return {
    tabs: Object.fromEntries(uniqueNames.map((name) => [name, { markdown: "" }])),
    ...(uniqueNames.length > 1 ? { tabOrder: uniqueNames } : {}),
  };
}

export function alignReportContentToTemplate(
  content: ReportContent,
  dimensions: string[],
): ReportContent {
  const normalized = normalizeReportContent(content);
  const next = emptyReportContent(dimensions);
  const normalizedTabs = normalized.tabs ?? {};
  for (const name of Object.keys(next.tabs ?? {})) {
    next.tabs![name] = normalizedTabs[name] ?? { markdown: "" };
  }
  return withBodyRestore(
    withAssistantDraft(
      withOptionalMeta(
        next,
        normalized.assignment,
        normalized.schedule,
        normalized.keyPointPrompts,
        normalized.keyPointExtraction,
      ),
      normalized.assistantDraft,
    ),
    normalized.bodyRestore,
  );
}

export function clearReportContent(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  return withBodyRestore(
    withAssistantDraft(
      withOptionalMeta(
        { tabs: {} },
        normalized.assignment,
        normalized.schedule,
        normalized.keyPointPrompts,
        normalized.keyPointExtraction,
      ),
      normalized.assistantDraft,
    ),
    normalized.bodyRestore,
  );
}

export function normalizeReportContent(value: unknown): ReportContent {
  if (!value || typeof value !== "object") return emptyReportContent();
  const record = value as {
    markdown?: unknown;
    tabs?: Record<string, { markdown?: unknown; sections?: LegacySection[] }>;
    tabOrder?: unknown;
    assignment?: unknown;
    schedule?: unknown;
    keyPointPrompts?: unknown;
    keyPointExtraction?: unknown;
    delivered?: unknown;
    assistantDraft?: unknown;
    bodyRestore?: unknown;
    received?: unknown;
  };
  const assignment = parseAssignmentMeta(record.assignment);
  const schedule = parseScheduleMeta(record.schedule);
  const keyPointPrompts = parseKeyPointPrompts(record.keyPointPrompts);
  const keyPointExtraction = parseKeyPointExtraction(record.keyPointExtraction);
  const delivered = parseBodySnapshot(record.delivered, false);
  const assistantDraft = parseBodySnapshot(record.assistantDraft, false);
  const bodyRestore = parseBodyRestore(record.bodyRestore);
  const received = parseBodySnapshot(record.received, true);

  if (record.tabs && typeof record.tabs === "object") {
    const tabs = parseReportTabs(record.tabs);
    let base: ReportContent;
    if (!tabs) {
      base = { tabs: {} };
    } else if (Array.isArray(record.tabOrder)) {
      const tabOrder = resolveTabNames(tabs, record.tabOrder);
      base = {
        tabs: reorderTabsRecord(tabs, tabOrder),
        ...(tabOrder.length > 0 ? { tabOrder } : {}),
      };
    } else {
      base = { tabs };
    }
    return finishReportContent(
      withOptionalMeta(base, assignment, schedule, keyPointPrompts, keyPointExtraction),
      delivered,
      assistantDraft,
      bodyRestore,
      received,
    );
  }

  if (typeof record.markdown === "string") {
    return finishReportContent(
      withOptionalMeta(
        { tabs: { [newTabName()]: { markdown: record.markdown } } },
        assignment,
        schedule,
        keyPointPrompts,
        keyPointExtraction,
      ),
      delivered,
      assistantDraft,
      bodyRestore,
      received,
    );
  }
  return finishReportContent(
    withOptionalMeta(
      emptyReportContent(),
      assignment,
      schedule,
      keyPointPrompts,
      keyPointExtraction,
    ),
    delivered,
    assistantDraft,
    bodyRestore,
    received,
  );
}

function finishReportContent(
  content: ReportContent,
  delivered: ReportBodySnapshot | undefined,
  assistantDraft: ReportBodySnapshot | undefined,
  bodyRestore: ReportBodyRestore | undefined,
  received: ReportBodySnapshot | undefined,
): ReportContent {
  return withReceivedBody(
    withBodyRestore(
      withAssistantDraft(withDeliveredBody(content, delivered), assistantDraft),
      bodyRestore,
    ),
    received,
  );
}

function withReceivedBody(
  content: ReportContent,
  received: ReportBodySnapshot | undefined,
): ReportContent {
  if (!received) return content;
  return { ...content, received };
}

function parseBodyRestore(value: unknown): ReportBodyRestore | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ReportBodyRestore>;
  const previous = parseBodySnapshot(row.previous, true);
  const latest = parseBodySnapshot(row.latest, true);
  if (!previous || !latest) return undefined;
  if (row.showing !== "latest" && row.showing !== "previous") return undefined;
  if (typeof row.sourceMessageId !== "string" || row.sourceMessageId.length === 0) return undefined;
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) {
    return undefined;
  }
  return {
    sourceMessageId: row.sourceMessageId,
    revision: row.revision,
    showing: row.showing,
    previous,
    latest,
  };
}

function reportBodySnapshot(content: ReportContent): ReportBodySnapshot {
  const normalized = normalizeReportContent(content);
  return {
    tabs: { ...normalized.tabs },
    ...(normalized.tabOrder ? { tabOrder: [...normalized.tabOrder] } : {}),
  };
}

function cloneSnapshot(snapshot: ReportBodySnapshot): ReportBodySnapshot {
  return {
    tabs: { ...snapshot.tabs },
    ...(snapshot.tabOrder ? { tabOrder: [...snapshot.tabOrder] } : {}),
  };
}

export function insertAssistantReportBody(
  stored: ReportContent,
  inserted: ReportContent,
  sourceMessageId: string,
): ReportContent {
  const current = normalizeReportContent(stored);
  if (current.bodyRestore?.sourceMessageId === sourceMessageId) return current;
  const latest = reportBodySnapshot(inserted);
  const previous = reportBodySnapshot(current);
  const { tabOrder: _dropOrder, ...rest } = current;
  return {
    ...rest,
    tabs: { ...latest.tabs },
    ...(latest.tabOrder ? { tabOrder: [...latest.tabOrder] } : {}),
    assistantDraft: cloneSnapshot(latest),
    bodyRestore: {
      sourceMessageId,
      revision: (current.bodyRestore?.revision ?? 0) + 1,
      showing: "latest",
      previous,
      latest: cloneSnapshot(latest),
    },
  };
}

export function switchReportBodyVersion(stored: ReportContent): ReportContent {
  const current = normalizeReportContent(stored);
  const restore = current.bodyRestore;
  if (!restore) return current;
  const live = reportBodySnapshot(current);
  const showing = restore.showing === "latest" ? "previous" : "latest";
  const previous = restore.showing === "previous" ? live : restore.previous;
  const latest = restore.showing === "latest" ? live : restore.latest;
  const target = showing === "latest" ? latest : previous;
  const { tabOrder: _dropOrder, ...rest } = current;
  return {
    ...rest,
    tabs: { ...target.tabs },
    ...(target.tabOrder ? { tabOrder: [...target.tabOrder] } : {}),
    bodyRestore: {
      ...restore,
      showing,
      revision: restore.revision + 1,
      previous,
      latest,
    },
  };
}

export function reportBodyRestoreView(content: ReportContent): ReportBodyRestoreView | null {
  const restore = normalizeReportContent(content).bodyRestore;
  if (!restore) return null;
  return {
    sourceMessageId: restore.sourceMessageId,
    revision: restore.revision,
    showing: restore.showing,
  };
}

export function publishMemberReportDelivery(content: ReportContent): ReportContent {
  const next = normalizeReportContent(content);
  return { ...next, delivered: reportBodySnapshot(next) };
}

export function retainMemberReportDelivery(
  stored: ReportContent,
  incoming: ReportContent,
): ReportContent {
  const previous = normalizeReportContent(stored);
  const next = normalizeReportContent(incoming);
  const delivered = previous.delivered
    ? cloneSnapshot(previous.delivered)
    : reportBodySnapshot(previous);
  return {
    ...next,
    delivered,
  };
}

export function reportContentForAuthor(content: ReportContent): ReportContent {
  const {
    delivered: _delivered,
    assistantDraft: _assistantDraft,
    bodyRestore: _bodyRestore,
    ...rest
  } = normalizeReportContent(content);
  return rest;
}

export function reportContentForRecipient(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  const {
    delivered,
    assistantDraft: _assistantDraft,
    bodyRestore: _bodyRestore,
    tabOrder: _authorTabOrder,
    ...rest
  } = normalized;
  if (!delivered) {
    return normalized.tabOrder ? { ...rest, tabOrder: normalized.tabOrder } : rest;
  }
  const names = resolveTabNames(delivered.tabs, delivered.tabOrder);
  return {
    ...rest,
    tabs: reorderTabsRecord(delivered.tabs, names),
    ...(delivered.tabOrder ? { tabOrder: names } : {}),
  };
}

export function reportTabsEqual(left: ReportContent, right: ReportContent): boolean {
  const a = orderedReportTabEntries(normalizeReportContent(left));
  const b = orderedReportTabEntries(normalizeReportContent(right));
  return JSON.stringify(a) === JSON.stringify(b);
}

export function withReceivedSnapshot(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  const entries = orderedReportTabEntries(normalized);
  const tabs = Object.fromEntries(entries.map(([name, tab]) => [name, { markdown: tab.markdown }]));
  return {
    ...normalized,
    received: {
      tabs,
      ...(normalized.tabOrder ? { tabOrder: entries.map(([name]) => name) } : {}),
    },
  };
}

export function memberReportMatchesReceived(content: ReportContent): boolean {
  const normalized = normalizeReportContent(content);
  if (!normalized.received) return false;
  return reportTabsEqual(normalized, {
    tabs: normalized.received.tabs,
    ...(normalized.received.tabOrder ? { tabOrder: normalized.received.tabOrder } : {}),
  });
}

export function reportContentToMarkdown(content: ReportContent): string {
  const normalized = normalizeReportContent(content);
  const tabs = orderedReportTabEntries(normalized);
  if (tabs.length === 0) return "";
  return tabs
    .map(([name, tab]) => {
      const body = tab.markdown.trim();
      return body.length > 0 ? `# ${name}\n\n${body}` : `# ${name}`;
    })
    .join("\n\n");
}
