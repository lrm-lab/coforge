import { ARTIFACT_SHORT_ID_PATTERN, decodeArtifactShortId } from "./artifact-short-id";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_TOKEN = `(?:${UUID}|${ARTIFACT_SHORT_ID_PATTERN})`;
const DOC_PARAM = new RegExp(
  String.raw`(?:[?&]doc=|(?:\/w\/[^\s/?#]+)?\/artifacts\/|\/a\/)(${ID_TOKEN})(?=[/?#.,;:!?)\]"'\s]|$)`,
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

export function artifactIdsInBody(body: string, limit = 3): string[] {
  const ids: string[] = [];
  for (const link of body.match(APP_LINK) ?? [])
    for (const match of link.matchAll(DOC_PARAM)) {
      const id = decodeArtifactShortId(match[1]!);
      if (id !== null && !ids.includes(id)) {
        ids.push(id);
        if (ids.length >= limit) return ids;
      }
    }
  return ids;
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
