import { ARTIFACT_SHORT_ID_PATTERN, decodeArtifactShortId } from "./artifact-short-id";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_TOKEN = `(?:${UUID}|${ARTIFACT_SHORT_ID_PATTERN})`;
const DOC_PARAM = new RegExp(
  String.raw`(?:[?&]doc=|(?:\/w\/[^\s/?#]+)?\/artifacts\/|\/a\/)(${ID_TOKEN})(?=[/?#&.,;:!?)\]"'\s]|$)`,
  "gi",
);
const APP_LINK =
  /(?:https?:\/\/[^\s/]+)?(?:\/[a-z]{2}(?:-[A-Z]{2})?)?(?:\/w\/[^\s/?#]+\/[^\s)\]>"']*|\/(?:artifacts|a)\/[^\s)\]>"']*)/g;

function extractArtifactId(link: string): string | undefined {
  for (const match of link.matchAll(DOC_PARAM)) {
    const decoded = decodeArtifactShortId(match[1]!);
    if (decoded !== null) return decoded;
  }
  return undefined;
}

export type ArtifactBodyLink = {
  id: string;
  embed: boolean;
  version?: number;
};

const POSITIVE_INT = /^[1-9]\d*$/;

function parseLinkOptions(link: string): { embed: boolean; version?: number } {
  const queryStart = link.indexOf("?");
  if (queryStart === -1) return { embed: false };
  const hashStart = link.indexOf("#", queryStart);
  const params = new URLSearchParams(
    link.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart),
  );
  const rawEmbed = params.get("embed");
  const embed = rawEmbed !== null && (rawEmbed === "" || rawEmbed === "1" || rawEmbed === "true");
  const rawVersion = params.get("version") ?? params.get("v");
  const parsed = rawVersion && POSITIVE_INT.test(rawVersion) ? Number(rawVersion) : undefined;
  const version = parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
  return version === undefined ? { embed } : { embed, version };
}

export function artifactLinksInBody(body: string, limit = 3): ArtifactBodyLink[] {
  const links: ArtifactBodyLink[] = [];
  const byId = new Map<string, ArtifactBodyLink>();
  for (const link of body.match(APP_LINK) ?? []) {
    const cleaned = link.replace(TRAILING, "");
    const options = parseLinkOptions(cleaned);
    for (const match of cleaned.matchAll(DOC_PARAM)) {
      const id = decodeArtifactShortId(match[1]!);
      if (id === null) continue;
      const existing = byId.get(id);
      if (existing) {
        if (options.embed) existing.embed = true;
        if (existing.version === undefined && options.version !== undefined)
          existing.version = options.version;
        continue;
      }
      if (links.length >= limit) return links;
      const entry: ArtifactBodyLink =
        options.version === undefined
          ? { id, embed: options.embed }
          : { id, embed: options.embed, version: options.version };
      byId.set(id, entry);
      links.push(entry);
    }
  }
  return links;
}

export function artifactIdsInBody(body: string, limit = 3): string[] {
  return artifactLinksInBody(body, limit).map((link) => link.id);
}

const LINK_IN_TEXT = new RegExp(String.raw`(\[[^\]]*\]\(|<)?(${APP_LINK.source})(\))?`, "g");
const INLINE_CODE = /(`[^`\n]*`)/;
const TRAILING = /[.,;:!?]+$/;

export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "embed"; link: ArtifactBodyLink };

function standaloneArtifactLink(line: string): ArtifactBodyLink | null {
  const sole = line.trim();
  if (!sole || sole.match(APP_LINK)?.[0] !== sole) return null;
  const cleaned = sole.replace(TRAILING, "");
  const id = extractArtifactId(cleaned);
  if (id === undefined) return null;
  const options = parseLinkOptions(cleaned);
  return options.version === undefined
    ? { id, embed: options.embed }
    : { id, embed: options.embed, version: options.version };
}

function titleArtifactLinksInLine(line: string, titles: ReadonlyMap<string, string>): string {
  const titled = (text: string) =>
    text.replace(LINK_IN_TEXT, (whole, named: string | undefined, found: string, close) => {
      if (named) return whole;
      const link = found.replace(TRAILING, "");
      const id = extractArtifactId(link);
      const title = id === undefined ? undefined : titles.get(id);
      if (title === undefined) return whole;
      const label = title.replace(/[[\]\\*_`]/g, (char) => `\\${char}`);
      return `[${label}](${link})${found.slice(link.length)}${close ?? ""}`;
    });
  return line
    .split(INLINE_CODE)
    .map((piece, index) => (index % 2 ? piece : titled(piece)))
    .join("");
}

export function bodyWithArtifactTitles(
  body: string,
  titles: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(),
): string {
  if (titles.size === 0 && placeholders.size === 0) return body;
  const isCardLine = (line: string) => {
    const standalone = standaloneArtifactLink(line);
    return standalone !== null && (titles.has(standalone.id) || placeholders.has(standalone.id));
  };
  const lines = body.split("\n");
  const code = codeLines(lines);
  let dropped = false;
  const shown = lines.flatMap((line, at) => {
    if (code[at]) return [line];
    if (isCardLine(line)) return ((dropped = true), []);
    return [titleArtifactLinksInLine(line, titles)];
  });
  const text = shown.join("\n");
  return dropped ? text.trimEnd() : text;
}

export function splitBodyWithInlineEmbeds(
  body: string,
  embedIds: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(),
  limit = 3,
): BodySegment[] {
  if (embedIds.size === 0) {
    const text = bodyWithArtifactTitles(body, titles, placeholders);
    return text ? [{ kind: "text", text }] : [];
  }
  const lines = body.split("\n");
  const code = codeLines(lines);
  const segments: BodySegment[] = [];
  let textLines: string[] = [];
  let droppedText = false;
  const emittedEmbeds = new Set<string>();

  const flushText = () => {
    if (textLines.length === 0) return;
    const raw = textLines.join("\n");
    const trimmed = droppedText || segments.length > 0 ? raw.trim() : raw;
    if (trimmed) segments.push({ kind: "text", text: trimmed });
    textLines = [];
    droppedText = false;
  };

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (code[at]) {
      textLines.push(line);
      continue;
    }
    const standalone = standaloneArtifactLink(line);
    if (standalone && standalone.embed && embedIds.has(standalone.id)) {
      droppedText = true;
      if (!emittedEmbeds.has(standalone.id) && emittedEmbeds.size < limit) {
        flushText();
        emittedEmbeds.add(standalone.id);
        segments.push({ kind: "embed", link: standalone });
      }
      continue;
    }
    if (standalone && (titles.has(standalone.id) || placeholders.has(standalone.id))) {
      droppedText = true;
      continue;
    }
    textLines.push(titleArtifactLinksInLine(line, titles));
  }
  flushText();
  return segments;
}

export type BodyArtifactAnalysis = {
  displayBody: string;
  segments: BodySegment[];
  inlineEmbedIds: ReadonlySet<string>;
  trailingLinks: ArtifactBodyLink[];
  hasText: boolean;
  lastTextIndex: number;
  longestTextIndex: number;
};

export function analyzeBodyArtifacts(
  body: string,
  allLinks: readonly ArtifactBodyLink[],
  embedIds: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(),
  limit = 3,
): BodyArtifactAnalysis {
  const segments = splitBodyWithInlineEmbeds(body, embedIds, titles, placeholders, limit);
  const inlineEmbedIds = new Set<string>();
  let lastTextIndex = -1;
  let longestTextIndex = -1;
  let longestTextLength = -1;
  let textCount = 0;
  let firstText = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind === "embed") {
      inlineEmbedIds.add(segment.link.id);
    } else {
      if (textCount === 0) firstText = segment.text;
      textCount += 1;
      lastTextIndex = i;
      if (segment.text.length > longestTextLength) {
        longestTextLength = segment.text.length;
        longestTextIndex = i;
      }
    }
  }
  const displayBody =
    inlineEmbedIds.size === 0
      ? firstText
      : textCount === 0
        ? ""
        : textCount === 1
          ? firstText
          : segments
              .filter(
                (segment): segment is { kind: "text"; text: string } => segment.kind === "text",
              )
              .map((segment) => segment.text)
              .join("\n\n");
  const trailingLinks =
    inlineEmbedIds.size === 0
      ? [...allLinks]
      : allLinks.filter((link) => !inlineEmbedIds.has(link.id));
  return {
    displayBody,
    segments,
    inlineEmbedIds,
    trailingLinks,
    hasText: displayBody.trim().length > 0,
    lastTextIndex,
    longestTextIndex,
  };
}

function codeLines(lines: readonly string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && (fence === null || (mark[0] === fence[0] && mark.length >= fence.length))) {
      fence = fence === null ? mark : null;
      return true;
    }
    return fence !== null || /^(?: {4}|\t)/.test(line);
  });
}
