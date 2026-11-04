/**
 * An artifact's link (task #514): its own page, `/w/<slug>/artifacts/<id>`, which "Copy link"
 * gives; before it, its home conversation's page with `doc=<id>` (task #385), which still opens
 * it. A message that carries either shows the artifact's card.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOC_PARAM = new RegExp(String.raw`(?:[?&]doc=|/w/[^\s/?#]+/artifacts/)(${UUID})\b`, "gi");
/** A link to a page of this app: `/w/<slug>/…`, with or without a locale or an origin. */
const APP_LINK =
  /(?:https?:\/\/[^\s/]+)?(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/w\/[^\s/?#]+\/[^\s)\]>"']*/g;

/** The documents a message body links to, in order, each once; at most `limit`. */
export function artifactIdsInBody(body: string, limit = 3): string[] {
  const ids: string[] = [];
  for (const link of body.match(APP_LINK) ?? [])
    for (const match of link.matchAll(DOC_PARAM)) {
      const id = match[1]!.toLowerCase();
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= limit) return ids;
    }
  return ids;
}

/** One app link, bare, as a Markdown link's target or in `<…>`, with what stands around it. */
const LINK_IN_TEXT = new RegExp(String.raw`(\[[^\]]*\]\(|<)?(${APP_LINK.source})(\))?`, "g");
/** Code, whose text is shown as written. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
/** What ends a sentence after a bare link rather than the link itself, as GFM autolinks read it. */
const TRAILING = /[.,;:!?]+$/;

/**
 * A message body as it reads once its documents' cards show (task #385, #514): a line that is only
 * a document's link says nothing its card below does not, so it reads as nothing (a body of such
 * lines alone, as nothing at all); elsewhere a bare document link reads as the document's title,
 * still a link. `titles` holds the documents whose cards show; any other link, one the writer
 * already named (`[text](link)`, `<link>`), and one in code stay as written.
 */
export function bodyWithArtifactTitles(body: string, titles: ReadonlyMap<string, string>): string {
  if (titles.size === 0) return body;
  const titleOf = (link: string) => {
    const id = [...link.matchAll(DOC_PARAM)][0]?.[1]?.toLowerCase();
    return id === undefined ? undefined : titles.get(id);
  };
  const shown = withoutCardLines(body, (line) => {
    const sole = line.trim();
    return sole.match(APP_LINK)?.[0] === sole && titleOf(sole) !== undefined;
  });
  const titled = (text: string) =>
    text.replace(LINK_IN_TEXT, (whole, named: string | undefined, found: string, close) => {
      if (named) return whole;
      const link = found.replace(TRAILING, "");
      const title = titleOf(link);
      if (title === undefined) return whole;
      const label = title.replace(/[[\]\\*_`]/g, (char) => `\\${char}`);
      return `[${label}](${link})${found.slice(link.length)}${close ?? ""}`;
    });
  // Split on code: the odd pieces are code.
  return shown
    .split(CODE)
    .map((piece, at) => (at % 2 ? piece : titled(piece)))
    .join("");
}

/** `body` without the lines `isCardLine` names, outside fenced code; nothing left over at its end. */
function withoutCardLines(body: string, isCardLine: (line: string) => boolean): string {
  let fenced = false;
  let dropped = false;
  const kept = body.split("\n").filter((line) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    else if (!fenced && isCardLine(line)) return !(dropped = true);
    return true;
  });
  return dropped ? kept.join("\n").trimEnd() : body;
}
