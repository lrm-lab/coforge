import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { viewerDirectConversationWhere } from "./viewer-direct-conversations.server";
import { lockMemberPins, setConversationPin } from "./conversation-pins.server";
import { lockConversation } from "./conversation-lock.server";
import { announceViewerEvent, type ConversationRealtime } from "./conversation-realtime.server";
import {
  chatSectionFields,
  chatSectionPatch,
  chatSectionSortModes,
  type ChatSection,
  type ChatSectionSortMode,
} from "#src/features/conversations/chat-section.schemas";
import { isBuiltInSection } from "#src/features/conversations/directory-section-order";

/** The column is plain text; a value this build does not know reads as the drag order. */
function sortModeOf(value: string): ChatSectionSortMode {
  return (chatSectionSortModes as readonly string[]).includes(value)
    ? (value as ChatSectionSortMode)
    : "manual";
}

/** One member's personal Chat groups. Every read/write keeps the trusted user + Workspace scope. */
export class ChatSections {
  constructor(
    private readonly db: PrismaClient,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly realtime?: Pick<ConversationRealtime, "viewerChanged">,
  ) {}

  private get scope() {
    return { workspaceId: this.workspaceId, userId: this.userId };
  }

  private async authorize() {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: this.scope },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
  }

  async list(): Promise<ChatSection[]> {
    await this.authorize();
    const sections = await this.db.chatSection.findMany({
      where: this.scope,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        emoji: true,
        collapsed: true,
        sortOrder: true,
        sortMode: true,
        conversations: {
          where: { ...this.scope, leftAt: null },
          select: { conversationId: true },
          orderBy: [{ chatSectionSortOrder: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
        },
      },
    });
    return sections.map(({ conversations, sortMode, ...section }) => ({
      ...section,
      sortMode: sortModeOf(sortMode),
      conversationIds: conversations.map((member) => member.conversationId),
    }));
  }

  async create(input: { name: string; emoji: string | null }) {
    await this.authorize();
    const parsed = chatSectionFields.safeParse(input);
    if (!parsed.success) throw new AppError("INVALID_INPUT");
    const section = await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, this.workspaceId, this.userId);
      const { _max } = await tx.chatSection.aggregate({
        where: this.scope,
        _max: { sortOrder: true },
      });
      return tx.chatSection.create({
        data: { ...this.scope, ...parsed.data, sortOrder: (_max.sortOrder ?? -1) + 1 },
        select: { id: true, name: true, emoji: true, collapsed: true, sortOrder: true },
      });
    });
    return { ...section, sortMode: "manual" as const, conversationIds: [] as string[] };
  }

  async update(
    id: string,
    input: {
      name?: string;
      emoji?: string | null;
      collapsed?: boolean;
      sortMode?: ChatSectionSortMode;
    },
  ) {
    await this.authorize();
    const parsed = chatSectionPatch.safeParse(input);
    if (!parsed.success) throw new AppError("INVALID_INPUT");
    const changed = await this.db.chatSection.updateMany({
      where: { ...this.scope, id },
      data: parsed.data,
    });
    if (changed.count === 0) throw new AppError("NOT_FOUND");
  }

  async remove(id: string) {
    await this.authorize();
    await this.db.$transaction(async (tx) => {
      // Same member lock as move/pin: deletion cannot race a move into this section.
      await lockMemberPins(tx, this.workspaceId, this.userId);
      const removed = await tx.chatSection.deleteMany({ where: { ...this.scope, id } });
      if (removed.count === 0) throw new AppError("NOT_FOUND");
    });
  }

  /** The sidebar's saved section order (built-in keys and custom ids); empty when never dragged. */
  async order(): Promise<string[]> {
    await this.authorize();
    const saved = await this.db.workspaceMemberPreference.findUnique({
      where: { workspaceId_userId: this.scope },
      select: { chatSectionOrder: true },
    });
    return saved?.chatSectionOrder ?? [];
  }

  /**
   * Saves the sidebar's section order. `order` names custom sections by id and may also name the
   * built-in ones ("pinned", "channels", "agents"); with a built-in key, the whole order is kept as
   * the member's preference, and the custom sections take their `sortOrder` from it either way.
   */
  async reorder(order: readonly string[]) {
    await this.authorize();
    if (new Set(order).size !== order.length) throw new AppError("INVALID_INPUT");
    const ids = order.filter((key) => !isBuiltInSection(key));
    const keepsBuiltIns = ids.length !== order.length;
    await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, this.workspaceId, this.userId);
      const sections = await tx.chatSection.findMany({
        where: this.scope,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (ids.some((id) => !sections.some((section) => section.id === id)))
        throw new AppError("NOT_FOUND");
      // A group unseen by this tab retains its place after the requested groups.
      const sorted = [
        ...ids,
        ...sections.map((section) => section.id).filter((id) => !ids.includes(id)),
      ];
      for (const [sortOrder, id] of sorted.entries())
        await tx.chatSection.update({ where: { id }, data: { sortOrder } });
      if (keepsBuiltIns)
        await tx.workspaceMemberPreference.upsert({
          where: { workspaceId_userId: this.scope },
          create: { ...this.scope, chatSectionOrder: [...order] },
          update: { chatSectionOrder: [...order] },
        });
    });
  }

  async move(
    conversationId: string,
    sectionId: string | null,
    beforeConversationId?: string | null,
  ) {
    await this.authorize();
    const unpinned = await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, this.workspaceId, this.userId);
      if (sectionId) {
        const section = await tx.chatSection.findFirst({
          where: { ...this.scope, id: sectionId },
          select: { id: true },
        });
        if (!section) throw new AppError("NOT_FOUND");
      }
      // Follow the pin writer's lock order, and authorize after holding the conversation lock.
      await lockConversation(tx, conversationId);
      const member = await tx.conversationMember.findFirst({
        where: {
          ...this.scope,
          conversationId,
          leftAt: null,
          conversation: {
            archivedAt: null,
            ...VISIBLE_CONVERSATION_WHERE,
            OR: [{ channelName: { not: null } }, viewerDirectConversationWhere(this.userId)],
          },
        },
        select: { id: true },
      });
      if (!member) throw new AppError("ACCESS_DENIED");
      await tx.conversationMember.update({
        where: { id: member.id },
        data: { chatSectionId: sectionId, chatSectionSortOrder: 0, hiddenAt: null },
      });
      if (sectionId) {
        const members = await tx.conversationMember.findMany({
          where: {
            ...this.scope,
            chatSectionId: sectionId,
            leftAt: null,
            conversationId: { not: conversationId },
          },
          orderBy: [{ chatSectionSortOrder: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
          select: { id: true, conversationId: true },
        });
        const index = beforeConversationId
          ? members.findIndex((entry) => entry.conversationId === beforeConversationId)
          : members.length;
        if (index < 0) throw new AppError("INVALID_INPUT");
        members.splice(index, 0, { id: member.id, conversationId });
        for (const [chatSectionSortOrder, entry] of members.entries())
          await tx.conversationMember.update({
            where: { id: entry.id },
            data: { chatSectionSortOrder },
          });
        await tx.chatSection.update({ where: { id: sectionId }, data: { collapsed: false } });
      }
      return setConversationPin(tx, { ...this.scope, conversationId, memberId: member.id }, false);
    });
    if (unpinned)
      await announceViewerEvent(this.realtime, {
        userIds: [this.userId],
        event: { type: "pref.changed.v1", workspaceId: this.workspaceId, name: "pins" },
      });
  }
}
