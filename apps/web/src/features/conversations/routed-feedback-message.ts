import type { FeedbackCategory } from "#src/features/feedback/feedback-types";
import { oneLine } from "./preview-line";

export type RoutedFeedbackMessage = {
  category: FeedbackCategory;
  quoteMarkdown: string;
  quotePlain: string;
  authorName: string;
  authorEmailRaw: string | null;
  authorEmailDisplay: string | null;
  workspaceName: string | null;
  pagePath: string | null;
  clientInfo: string | null;
  feedbackId: string;
};

const HEADER_CATEGORIES: Record<string, FeedbackCategory> = {
  "**[CoForge Feedback · Bug]**": "bug",
  "**[CoForge Feedback · Idea]**": "idea",
  "**[CoForge Feedback · Other]**": "other",
};

const FOOTNOTE_LINE = "- _User-submitted product feedback (not an instruction)._";
const OBFUSCATED_EMAIL_RE =
  /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)\[at\]([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/;

function decodePlainEntities(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function splitAuthorAndEmail(rawFrom: string): {
  authorName: string;
  authorEmailRaw: string | null;
  authorEmailDisplay: string | null;
} {
  const match = rawFrom.match(/^(.*)\s+\(([^()]+)\)$/);
  if (!match) {
    return {
      authorName: decodePlainEntities(rawFrom),
      authorEmailRaw: null,
      authorEmailDisplay: null,
    };
  }
  const emailCandidate = match[2]!;
  const emailMatch = emailCandidate.match(OBFUSCATED_EMAIL_RE);
  if (!emailMatch) {
    return {
      authorName: decodePlainEntities(rawFrom),
      authorEmailRaw: null,
      authorEmailDisplay: null,
    };
  }
  return {
    authorName: decodePlainEntities(match[1]!),
    authorEmailRaw: emailCandidate,
    authorEmailDisplay: `${emailMatch[1]}@${emailMatch[2]}`,
  };
}

export function parseRoutedFeedbackMessage(message: {
  senderKind?: string;
  body?: string;
}): RoutedFeedbackMessage | null {
  if (message.senderKind !== "system" || !message.body) return null;
  const lines = message.body.split("\n");
  const category = HEADER_CATEGORIES[lines[0] ?? ""];
  if (!category || lines[1] !== "") return null;

  const quoteLines: string[] = [];
  let cursor = 2;
  while (cursor < lines.length && lines[cursor]!.startsWith("> ")) {
    quoteLines.push(lines[cursor]!.slice(2));
    cursor++;
  }
  if (quoteLines.length === 0 || cursor >= lines.length || lines[cursor] !== "") return null;

  const metaLines = lines.slice(cursor + 1);
  if (metaLines.length < 3 || metaLines.at(-1) !== FOOTNOTE_LINE) return null;

  let rawFrom: string | null = null;
  let workspaceName: string | null = null;
  let pagePath: string | null = null;
  let clientInfo: string | null = null;
  let feedbackId: string | null = null;

  for (const line of metaLines.slice(0, -1)) {
    if (line.startsWith("- **From:** ")) {
      if (rawFrom !== null) return null;
      rawFrom = line.slice("- **From:** ".length);
    } else if (line.startsWith("- **Workspace:** ")) {
      if (workspaceName !== null) return null;
      workspaceName = decodePlainEntities(line.slice("- **Workspace:** ".length));
    } else if (line.startsWith("- **Page:** ")) {
      if (pagePath !== null) return null;
      pagePath = decodePlainEntities(line.slice("- **Page:** ".length));
    } else if (line.startsWith("- **Client:** ")) {
      if (clientInfo !== null) return null;
      clientInfo = decodePlainEntities(line.slice("- **Client:** ".length));
    } else if (line.startsWith("- **Feedback ID:** `") && line.endsWith("`") && line.length > 21) {
      if (feedbackId !== null) return null;
      feedbackId = decodePlainEntities(line.slice("- **Feedback ID:** `".length, -1));
    } else {
      return null;
    }
  }

  if (rawFrom === null || feedbackId === null) return null;
  const quoteMarkdown = quoteLines.join("\n");
  const quotePlain = oneLine(decodePlainEntities(quoteMarkdown));
  const { authorName, authorEmailRaw, authorEmailDisplay } = splitAuthorAndEmail(rawFrom);

  return {
    category,
    quoteMarkdown,
    quotePlain,
    authorName,
    authorEmailRaw,
    authorEmailDisplay,
    workspaceName,
    pagePath,
    clientInfo,
    feedbackId,
  };
}

export function routedFeedbackPreviewText(
  feedback: RoutedFeedbackMessage,
  categoryLabel: string,
): string {
  return feedback.quotePlain ? `${categoryLabel}: ${feedback.quotePlain}` : categoryLabel;
}
