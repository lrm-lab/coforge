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
