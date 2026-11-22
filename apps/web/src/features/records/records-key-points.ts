export type KeyPointPromptHistoryEntry = {
  text: string;
  updatedAt: string;
};

export function keyPointHistoryIndexOf(
  history: readonly KeyPointPromptHistoryEntry[],
  entry: KeyPointPromptHistoryEntry,
): number {
  return history.findIndex(
    (candidate) => candidate.updatedAt === entry.updatedAt && candidate.text === entry.text,
  );
}

export type KeyPointPromptState = {
  text: string;
  updatedAt?: string;
  history: KeyPointPromptHistoryEntry[];
};

export type KeyPointPromptsMeta = {
  team: KeyPointPromptState;
  personal: KeyPointPromptState;
};

export type KeyPointExtractionStatus =
  | "generating"
  | "ready"
  | "failed"
  | "pending_setup"
  | "awaiting_confirm";

export type KeyPointExtractionMeta = {
  status: KeyPointExtractionStatus;
  promptSnapshot: string;
  markdown?: string;
  pendingMarkdown?: string;
  generatedAt?: string;
  error?: string;
  delivery?: "side-chat-confirm";
  confirmSessionId?: string;
};

export const KEY_POINT_PROMPT_HISTORY_LIMIT = 20;

export const DEFAULT_TEAM_KEY_POINT_PROMPT = [
  "请基于本周全组成员已提交的周报，提炼一份团队要点纪要。要求：",
  "1、按「本周进展、下周计划、要点总结」三部分组织，使用 Markdown 标题与条目列表；",
  "2、优先保留可核对的事实：完成事项、阻塞风险、关键结论与明确计划，避免空泛表述；",
  "3、合并重复信息，按主题归类；每条要点末尾必须用 Markdown 链接标注来源成员，格式为 [@显示名](/records/<reportId>)，reportId 取自「已提交成员」列表；同一事项多名成员则并列多个链接；",
  "4、语言简洁、描述清晰，少用过重的专业黑话；不确定处写「待确认」而非臆测；",
  "5、不要复述整篇周报原文，只输出提炼后的要点正文。",
].join("\n");

export const DEFAULT_PERSONAL_KEY_POINT_PROMPT = [
  "请阅读该成员本周已提交的周报全文，提炼个人要点。要求：",
  "1、按「本周进展、下周计划、要点总结」三部分组织，使用 Markdown 标题与条目列表；",
  "2、本周进展：列出已完成或推进中的关键事项，突出结果与影响；",
  "3、下周计划：列出明确计划与优先级，标出依赖或风险（如有）；",
  "4、要点总结：用 2–5 条概括本周核心信息，便于 Leader 快速扫读；",
  "5、语言简洁、描述清晰，少用过重的专业黑话；不要臆造周报中未出现的内容；",
  "6、只输出提炼后的 Markdown 正文，不要解释你的思考过程。",
].join("\n");

function parseKeyPointPromptState(value: unknown): KeyPointPromptState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { text?: unknown; updatedAt?: unknown; history?: unknown };
  const text = typeof row.text === "string" ? row.text : "";
  const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : undefined;
  const history = Array.isArray(row.history)
    ? row.history
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as { text?: unknown; updatedAt?: unknown };
          if (typeof item.text !== "string" || typeof item.updatedAt !== "string") return null;
          return { text: item.text, updatedAt: item.updatedAt };
        })
        .filter((entry): entry is KeyPointPromptHistoryEntry => entry !== null)
    : [];
  return updatedAt ? { text, updatedAt, history } : { text, history };
}

export function parseKeyPointPrompts(value: unknown): KeyPointPromptsMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { team?: unknown; personal?: unknown };
  const team = parseKeyPointPromptState(row.team);
  const personal = parseKeyPointPromptState(row.personal);
  if (!team && !personal) return undefined;
  return {
    team: team ?? emptyKeyPointPrompt(DEFAULT_TEAM_KEY_POINT_PROMPT),
    personal: personal ?? emptyKeyPointPrompt(DEFAULT_PERSONAL_KEY_POINT_PROMPT),
  };
}

const EXTRACTION_STATUSES = new Set<string>([
  "generating",
  "ready",
  "failed",
  "pending_setup",
  "awaiting_confirm",
]);

export function parseKeyPointExtraction(value: unknown): KeyPointExtractionMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as {
    status?: unknown;
    promptSnapshot?: unknown;
    markdown?: unknown;
    pendingMarkdown?: unknown;
    generatedAt?: unknown;
    error?: unknown;
    delivery?: unknown;
    confirmSessionId?: unknown;
  };
  if (typeof row.status !== "string" || !EXTRACTION_STATUSES.has(row.status)) return undefined;
  if (typeof row.promptSnapshot !== "string") return undefined;
  return {
    status: row.status as KeyPointExtractionStatus,
    promptSnapshot: row.promptSnapshot,
    ...(typeof row.markdown === "string" ? { markdown: row.markdown } : {}),
    ...(typeof row.pendingMarkdown === "string" ? { pendingMarkdown: row.pendingMarkdown } : {}),
    ...(typeof row.generatedAt === "string" ? { generatedAt: row.generatedAt } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    ...(row.delivery === "side-chat-confirm" ? { delivery: "side-chat-confirm" as const } : {}),
    ...(typeof row.confirmSessionId === "string" && row.confirmSessionId.trim()
      ? { confirmSessionId: row.confirmSessionId.trim() }
      : {}),
  };
}

export function emptyKeyPointPrompt(text = ""): KeyPointPromptState {
  return { text, history: [] };
}

export function emptyKeyPointPrompts(): KeyPointPromptsMeta {
  return {
    team: emptyKeyPointPrompt(DEFAULT_TEAM_KEY_POINT_PROMPT),
    personal: emptyKeyPointPrompt(DEFAULT_PERSONAL_KEY_POINT_PROMPT),
  };
}

export function applyKeyPointPromptText(
  current: KeyPointPromptState | undefined,
  nextText: string,
  updatedAt: Date,
): KeyPointPromptState {
  const previous = current ?? emptyKeyPointPrompt();
  const text = nextText;
  const stamp = updatedAt.toISOString();
  if (previous.text === text) {
    return previous.updatedAt
      ? { text, updatedAt: previous.updatedAt, history: previous.history }
      : { text, updatedAt: stamp, history: previous.history };
  }
  const history =
    previous.text.trim().length > 0
      ? [
          {
            text: previous.text,
            updatedAt: previous.updatedAt ?? stamp,
          },
          ...previous.history,
        ].slice(0, KEY_POINT_PROMPT_HISTORY_LIMIT)
      : previous.history;
  return { text, updatedAt: stamp, history };
}

export function removeKeyPointPromptHistoryEntry(
  current: KeyPointPromptState,
  historyIndex: number,
): KeyPointPromptState {
  if (historyIndex < 0 || historyIndex >= current.history.length) return current;
  return {
    ...current,
    history: current.history.filter((_, index) => index !== historyIndex),
  };
}
