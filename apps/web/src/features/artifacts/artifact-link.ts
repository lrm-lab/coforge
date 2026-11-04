import { conversationRoute } from "#src/features/conversations/last-conversation";

/**
 * A document's link (task #385): its home conversation's page with `doc=<id>`, which opens the
 * document beside the chat. A message that carries such a link shows the document's card; the
 * link is what "Copy link" gives.
 */

const DOC_PARAM = /[?&]doc=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
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

/** Where a document lives: a channel, a DM, or the Workspace (`documents.load`'s `homeKind`). */
export type ArtifactHomeKind = "channel" | "dm" | "workspace";

/**
 * The route that opens a document: its own conversation's page with `doc=<id>`, whatever page it
 * was opened on, so the link opens for everyone who can read the conversation. A Workspace
 * document has no page of its own yet, so no link.
 */
export function artifactRoute(
  workspaceSlug: string,
  home: { kind: ArtifactHomeKind; conversationId: string | null },
  artifactId: string,
) {
  if (home.kind === "workspace" || !home.conversationId) return undefined;
  const target =
    home.kind === "channel" ? { channelId: home.conversationId } : { dmId: home.conversationId };
  return { ...conversationRoute(target, workspaceSlug), search: { doc: artifactId } };
}

/** One app link, bare, as a Markdown link's target or in `<…>`, with what stands around it. */
const LINK_IN_TEXT = new RegExp(String.raw`(\[[^\]]*\]\(|<)?(${APP_LINK.source})(\))?`, "g");
/** Code, whose text is shown as written. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
/** What ends a sentence after a bare link rather than the link itself, as GFM autolinks read it. */
const TRAILING = /[.,;:!?]+$/;

/**
 * A message body as it reads once its documents' cards show (task #385): a body that is only one
 * document link says nothing the card does not, so it reads as nothing; elsewhere a bare document
 * link reads as the document's title, still a link. `titles` holds the documents whose cards
 * show; any other link, one the writer already named (`[text](link)`, `<link>`), and one in code
 * stay as written.
 */
export function bodyWithArtifactTitles(body: string, titles: ReadonlyMap<string, string>): string {
  if (titles.size === 0) return body;
  const titleOf = (link: string) => {
    const id = [...link.matchAll(DOC_PARAM)][0]?.[1]?.toLowerCase();
    return id === undefined ? undefined : titles.get(id);
  };
  const sole = body.trim();
  if (sole.match(APP_LINK)?.[0] === sole && titleOf(sole) !== undefined) return "";
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
  return body
    .split(CODE)
    .map((piece, at) => (at % 2 ? piece : titled(piece)))
    .join("");
}
