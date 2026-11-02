/**
 * Text a recycle briefing quotes from the old session (messages, file bodies, tool output) was
 * written by someone else. Two rules keep it in its place (task #336, Raft 1.0.59's wake panel):
 * it cannot close one of the panel's sections early, and only a whole CoForge message header
 * starts a message.
 */

const PANEL_CLOSING_TAG = /<\/\s*(recent-messages|recent-actions|objects-in-play|object)\s*>/giu;

/** `text` with every closing tag of a panel section escaped, so it stays inside its section. */
export function escapePanelClosingTags(text: string): string {
  return text.replace(PANEL_CLOSING_TAG, (_, tag: string) => `&lt;/${tag}&gt;`);
}

/**
 * The header a `coforge message check|resolve` line (`[target=<t> msg=<id8-4> time=... type=...]`)
 * or a `coforge message read` line (`[3/50 msg=<uuid> seq=... time=... type=...]`) opens with,
 * whole: a line that merely starts `[target=` is not one.
 */
export const COFORGE_MESSAGE_HEADER =
  /^\[(?:target=\S+|\d+\/\d+) msg=[0-9a-f]{8}-[0-9a-f]{4}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?: [^\]\n]*?)? time=\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ type=(?:human|agent|system)(?: [^\]\n]*)?\]/u;
