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
  type ChatSection,
} from "#src/features/conversations/chat-section.schemas";

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
        conversations: {
          where: { ...this.scope, leftAt: null },
          select: { conversationId: true },
          orderBy: [{ chatSectionSortOrder: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
        },
      },
    });
    return sections.map(({ conversations, ...section }) => ({
      ...section,
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
    return { ...section, conversationIds: [] as string[] };
  }

  async update(id: string, input: { name?: string; emoji?: string | null; collapsed?: boolean }) {
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

  async reorder(ids: readonly string[]) {
    await this.authorize();
    if (new Set(ids).size !== ids.length) throw new AppError("INVALID_INPUT");
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
      const order = [
        ...ids,
        ...sections.map((section) => section.id).filter((id) => !ids.includes(id)),
      ];
      for (const [sortOrder, id] of order.entries())
        await tx.chatSection.update({ where: { id }, data: { sortOrder } });
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
