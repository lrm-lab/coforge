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

export type ReportContent = {
  tabs?: Record<string, ReportTab>;
  markdown?: string;
  assignment?: ReportAssignmentMeta;
  schedule?: ReportScheduleMeta;
  keyPointPrompts?: KeyPointPromptsMeta;
  keyPointExtraction?: KeyPointExtractionMeta;
  delivered?: { tabs: Record<string, ReportTab> };
  assistantDraft?: { tabs: Record<string, ReportTab> };
  received?: { tabs: Record<string, ReportTab> };
  bodyRestore?: ReportBodyRestore;
};

export type ReportBodyRestore = {
  sourceMessageId: string;
  revision: number;
  showing: "latest" | "previous";
  previous: { tabs: Record<string, ReportTab> };
  latest: { tabs: Record<string, ReportTab> };
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

function parseDeliveredBody(value: unknown): { tabs: Record<string, ReportTab> } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tabs = parseReportTabs((value as { tabs?: unknown }).tabs);
  if (!tabs) return undefined;
  return { tabs };
}

function withDeliveredBody(
  content: ReportContent,
  delivered: { tabs: Record<string, ReportTab> } | undefined,
): ReportContent {
  if (!delivered) return content;
  return { ...content, delivered };
}

function withAssistantDraft(
  content: ReportContent,
  assistantDraft: { tabs: Record<string, ReportTab> } | undefined,
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
  const delivered = parseDeliveredBody(record.delivered);
  const assistantDraft = parseDeliveredBody(record.assistantDraft);
  const bodyRestore = parseBodyRestore(record.bodyRestore);
  const received = parseSnapshotBody(record.received);

  if (record.tabs && typeof record.tabs === "object") {
    const tabs = parseReportTabs(record.tabs);
    const base = tabs ? { tabs } : { tabs: {} };
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
  delivered: { tabs: Record<string, ReportTab> } | undefined,
  assistantDraft: { tabs: Record<string, ReportTab> } | undefined,
  bodyRestore: ReportBodyRestore | undefined,
  received: { tabs: Record<string, ReportTab> } | undefined,
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
  received: { tabs: Record<string, ReportTab> } | undefined,
): ReportContent {
  if (!received) return content;
  return { ...content, received };
}

function parseSnapshotBody(value: unknown): { tabs: Record<string, ReportTab> } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as { tabs?: unknown }).tabs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (Object.keys(raw).length === 0) return { tabs: {} };
  const tabs = parseReportTabs(raw);
  if (!tabs) return undefined;
  return { tabs };
}

function parseBodyRestore(value: unknown): ReportBodyRestore | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ReportBodyRestore>;
  const previous = parseSnapshotBody(row.previous);
  const latest = parseSnapshotBody(row.latest);
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

function reportTabsSnapshot(content: ReportContent): Record<string, ReportTab> {
  return { ...normalizeReportContent(content).tabs };
}

export function insertAssistantReportBody(
  stored: ReportContent,
  inserted: ReportContent,
  sourceMessageId: string,
): ReportContent {
  const current = normalizeReportContent(stored);
  if (current.bodyRestore?.sourceMessageId === sourceMessageId) return current;
  const latest = reportTabsSnapshot(inserted);
  const previous = reportTabsSnapshot(current);
  return {
    ...current,
    tabs: latest,
    assistantDraft: { tabs: { ...latest } },
    bodyRestore: {
      sourceMessageId,
      revision: (current.bodyRestore?.revision ?? 0) + 1,
      showing: "latest",
      previous: { tabs: previous },
      latest: { tabs: { ...latest } },
    },
  };
}

export function switchReportBodyVersion(stored: ReportContent): ReportContent {
  const current = normalizeReportContent(stored);
  const restore = current.bodyRestore;
  if (!restore) return current;
  const live = reportTabsSnapshot(current);
  const showing = restore.showing === "latest" ? "previous" : "latest";
  const previous = restore.showing === "previous" ? { tabs: live } : restore.previous;
  const latest = restore.showing === "latest" ? { tabs: live } : restore.latest;
  const tabs = showing === "latest" ? latest.tabs : previous.tabs;
  return {
    ...current,
    tabs: { ...tabs },
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
  return { ...next, delivered: { tabs: { ...next.tabs } } };
}

export function retainMemberReportDelivery(
  stored: ReportContent,
  incoming: ReportContent,
): ReportContent {
  const previous = normalizeReportContent(stored);
  const next = normalizeReportContent(incoming);
  return {
    ...next,
    delivered: { tabs: { ...(previous.delivered?.tabs ?? previous.tabs) } },
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
  const {
    delivered,
    assistantDraft: _assistantDraft,
    bodyRestore: _bodyRestore,
    ...rest
  } = normalizeReportContent(content);
  if (!delivered) return rest;
  return { ...rest, tabs: delivered.tabs };
}

export function reportTabsEqual(left: ReportContent, right: ReportContent): boolean {
  const a = normalizeReportContent(left).tabs ?? {};
  const b = normalizeReportContent(right).tabs ?? {};
  return JSON.stringify(a) === JSON.stringify(b);
}

export function withReceivedSnapshot(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  const tabs = Object.fromEntries(
    Object.entries(normalized.tabs ?? {}).map(([name, tab]) => [name, { markdown: tab.markdown }]),
  );
  return { ...normalized, received: { tabs } };
}

export function memberReportMatchesReceived(content: ReportContent): boolean {
  const normalized = normalizeReportContent(content);
  if (!normalized.received) return false;
  return reportTabsEqual(normalized, { tabs: normalized.received.tabs });
}

export function reportContentToMarkdown(content: ReportContent): string {
  const normalized = normalizeReportContent(content);
  const tabs = Object.entries(normalized.tabs ?? {});
  if (tabs.length === 0) return "";
  return tabs
    .map(([name, tab]) => {
      const body = tab.markdown.trim();
      return body.length > 0 ? `# ${name}\n\n${body}` : `# ${name}`;
    })
    .join("\n\n");
}
