import { Prisma } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";

/** Only a destination key identifies a DM; internal conversations also have no channel name. */
export const DIRECT_CONVERSATION_WHERE = {
  directKey: { not: null },
} satisfies Prisma.ConversationWhereInput;

/** SQL counterpart of DIRECT_CONVERSATION_WHERE; aliases are repository-owned identifiers. */
export const directConversationSql = (alias: string) =>
  Prisma.sql`${Prisma.raw(alias)}."directKey" IS NOT NULL`;

/**
 * A `ConversationMember` row that has not left. `leftAt` is a soft-leave marker: member rows
 * can never be deleted once they own a Message or Task (`onDelete: Restrict`), so "is this
 * agent/human currently a member of this conversation" must always be spelled with this filter
 * rather than by row existence alone. Re-joining clears `leftAt` and keeps the same row, so a
 * read boundary or mute preference set before leaving survives a later re-join.
 */
export const ACTIVE_MEMBER_WHERE = { leftAt: null } satisfies Prisma.ConversationMemberWhereInput;

/**
 * A conversation the Workspace can see: not hidden from the whole Workspace by an owner or admin
 * (only `#general` ever is, see `Conversation.hiddenFromWorkspaceAt`). A hidden channel is gone
 * from every list, page, post, search and Agent surface until it is restored, so every channel
 * read filters through this, and a raw query checks `"hiddenFromWorkspaceAt" IS NULL`.
 */
export const VISIBLE_CONVERSATION_WHERE = {
  hiddenFromWorkspaceAt: null,
} satisfies Prisma.ConversationWhereInput;

/** An active membership of a channel (a conversation with a channel name), not of a DM. */
export const ACTIVE_CHANNEL_MEMBER_WHERE = {
  ...ACTIVE_MEMBER_WHERE,
  conversation: { channelName: { not: null } },
} satisfies Prisma.ConversationMemberWhereInput;

/**
 * A channel any Workspace member may read: it has a channel name (a DM has none), is public (a
 * private channel is its members' alone), is not archived, and is not hidden from the Workspace. The privacy rule for what a surface outside the
 * Workspace's own members (an installed app) may list.
 */
export const PUBLIC_CHANNEL_WHERE = {
  channelName: { not: null },
  archivedAt: null,
  visibility: CHANNEL_VISIBILITY.PUBLIC,
  ...VISIBLE_CONVERSATION_WHERE,
} satisfies Prisma.ConversationWhereInput;

/** Ordinary message targets name a channel or DM. Attachment comment seats only satisfy
 * Message author FKs; their membership never grants generic read/search/subscription access. */
export const TARGETABLE_CONVERSATION_WHERE = {
  OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
} satisfies Prisma.ConversationWhereInput;
