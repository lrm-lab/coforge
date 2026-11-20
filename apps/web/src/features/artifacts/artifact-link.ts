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

export function bodyWithArtifactTitles(
  body: string,
  titles: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(),
): string {
  if (titles.size === 0 && placeholders.size === 0) return body;
  const idOf = (link: string) => extractArtifactId(link);
  const titleOf = (link: string) => {
    const id = idOf(link);
    return id === undefined ? undefined : titles.get(id);
  };
  const isCardLine = (line: string) => {
    const sole = line.trim();
    if (sole.match(APP_LINK)?.[0] !== sole) return false;
    const id = idOf(sole);
    return id !== undefined && (titles.has(id) || placeholders.has(id));
  };
  const titled = (text: string) =>
    text.replace(LINK_IN_TEXT, (whole, named: string | undefined, found: string, close) => {
      if (named) return whole;
      const link = found.replace(TRAILING, "");
      const title = titleOf(link);
      if (title === undefined) return whole;
      const label = title.replace(/[[\]\\*_`]/g, (char) => `\\${char}`);
      return `[${label}](${link})${found.slice(link.length)}${close ?? ""}`;
    });
  const lines = body.split("\n");
  const code = codeLines(lines);
  let dropped = false;
  const shown = lines.flatMap((line, at) => {
    if (code[at]) return [line];
    if (isCardLine(line)) return ((dropped = true), []);
    // Split on inline code: the odd pieces are code.
    return [
      line
        .split(INLINE_CODE)
        .map((piece, index) => (index % 2 ? piece : titled(piece)))
        .join(""),
    ];
  });
  const text = shown.join("\n");
  return dropped ? text.trimEnd() : text;
}

/** Which lines are code: inside a ``` or ~~~ fence (closed by the same mark, at least as long),
 * the fence's own lines, or indented four spaces or a tab. */
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
