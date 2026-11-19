export type AiProvider = "chatgpt" | "claude";

export type ArtifactAiContext = {
  title: string;
  version?: number | undefined;
  url?: string | null | undefined;
  body?: string | null | undefined;
};

const COPY_BODY_LIMIT = 120_000;
const URL_PROMPT_BODY_LIMIT = 2_400;

const PROVIDER_BASE: Record<AiProvider, string> = {
  chatgpt: "https://chatgpt.com/?q=",
  claude: "https://claude.ai/new?q=",
};

function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}\n\n[truncated]`;
}

export function formatArtifactForAi(input: ArtifactAiContext): string {
  const header =
    input.version !== undefined ? `# ${input.title} (v${input.version})` : `# ${input.title}`;
  const lines = [header];
  if (input.url) lines.push(`Source: ${input.url}`);
  const body = input.body?.trim();
  if (body) {
    lines.push("", truncateText(body, COPY_BODY_LIMIT));
  }
  return lines.join("\n");
}

export function buildAiPromptUrl(provider: AiProvider, input: ArtifactAiContext): string {
  const lines = [`Please help me review and discuss this artifact: "${input.title}".`];
  if (input.url) lines.push(`Link: ${input.url}`);
  const body = input.body?.trim();
  if (body) {
    lines.push("", truncateText(body, URL_PROMPT_BODY_LIMIT));
  }
  return `${PROVIDER_BASE[provider]}${encodeURIComponent(lines.join("\n"))}`;
}
