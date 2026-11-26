import { z } from "zod";

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

const keyPointPromptHistoryEntrySchema = z.object({
  text: z.string(),
  updatedAt: z.string(),
});

const keyPointPromptStateSchema = z
  .object({
    text: z.string().catch(""),
    updatedAt: z.string().min(1).optional().catch(undefined),
    history: z
      .array(z.unknown())
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = keyPointPromptHistoryEntrySchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      )
      .catch([]),
  })
  .transform(({ text, updatedAt, history }): KeyPointPromptState =>
    updatedAt ? { text, updatedAt, history } : { text, history },
  );

function parseKeyPointPromptState(value: unknown): KeyPointPromptState | undefined {
  const parsed = keyPointPromptStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const keyPointPromptsEnvelopeSchema = z.object({
  team: z.unknown().optional(),
  personal: z.unknown().optional(),
});

export function parseKeyPointPrompts(value: unknown): KeyPointPromptsMeta | undefined {
  const parsed = keyPointPromptsEnvelopeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const team = parseKeyPointPromptState(parsed.data.team);
  const personal = parseKeyPointPromptState(parsed.data.personal);
  if (!team && !personal) return undefined;
  return {
    team: team ?? emptyKeyPointPrompt(DEFAULT_TEAM_KEY_POINT_PROMPT),
    personal: personal ?? emptyKeyPointPrompt(DEFAULT_PERSONAL_KEY_POINT_PROMPT),
  };
}

const keyPointExtractionSchema = z
  .object({
    status: z.enum(["generating", "ready", "failed", "pending_setup", "awaiting_confirm"]),
    promptSnapshot: z.string(),
    markdown: z.string().optional().catch(undefined),
    pendingMarkdown: z.string().optional().catch(undefined),
    generatedAt: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    delivery: z.literal("side-chat-confirm").optional().catch(undefined),
    confirmSessionId: z.string().trim().min(1).optional().catch(undefined),
  })
  .transform(
    ({
      status,
      promptSnapshot,
      markdown,
      pendingMarkdown,
      generatedAt,
      error,
      delivery,
      confirmSessionId,
    }): KeyPointExtractionMeta => ({
      status,
      promptSnapshot,
      ...(markdown !== undefined ? { markdown } : {}),
      ...(pendingMarkdown !== undefined ? { pendingMarkdown } : {}),
      ...(generatedAt !== undefined ? { generatedAt } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
      ...(confirmSessionId !== undefined ? { confirmSessionId } : {}),
    }),
  );

export function parseKeyPointExtraction(value: unknown): KeyPointExtractionMeta | undefined {
  const parsed = keyPointExtractionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
