import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { visibleChannelWhere } from "./channel-read-access.server";
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

function sortModeOf(value: string): ChatSectionSortMode {
  return (chatSectionSortModes as readonly string[]).includes(value)
    ? (value as ChatSectionSortMode)
    : "manual";
}

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

  private announceChanged() {
    return announceViewerEvent(this.realtime, {
      userIds: [this.userId],
      event: { type: REALTIME_EVENTS.prefChanged, workspaceId: this.workspaceId, name: "sections" },
    });
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
    await this.announceChanged();
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
    await this.announceChanged();
  }

  async remove(id: string) {
    await this.authorize();
    await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, this.workspaceId, this.userId);
      const removed = await tx.chatSection.deleteMany({ where: { ...this.scope, id } });
      if (removed.count === 0) throw new AppError("NOT_FOUND");
    });
    await this.announceChanged();
  }

  async order(): Promise<string[]> {
    await this.authorize();
    const saved = await this.db.workspaceMemberPreference.findUnique({
      where: { workspaceId_userId: this.scope },
      select: { chatSectionOrder: true },
    });
    return saved?.chatSectionOrder ?? [];
  }

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
      const sorted = [
        ...ids,
        ...sections.map((section) => section.id).filter((id) => !ids.includes(id)),
      ];
      if (sorted.length === 1) {
        await tx.chatSection.update({ where: { id: sorted[0]! }, data: { sortOrder: 0 } });
      } else if (sorted.length > 1) {
        const updates = sorted
          .map((id, sortOrder) => ({ id, sortOrder }))
          .sort((a, b) => a.id.localeCompare(b.id));
        await tx.$executeRaw`UPDATE "chat_sections" AS s
          SET "sortOrder" = v."sortOrder"
          FROM unnest(
            ${updates.map((row) => row.id)}::uuid[],
            ${updates.map((row) => row.sortOrder)}::int[]
          ) AS v("id", "sortOrder")
          WHERE s."id" = v."id"`;
      }
      if (keepsBuiltIns)
        await tx.workspaceMemberPreference.upsert({
          where: { workspaceId_userId: this.scope },
          create: { ...this.scope, chatSectionOrder: [...order] },
          update: { chatSectionOrder: [...order] },
        });
    });
    await this.announceChanged();
  }

  async move(
    conversationId: string,
    sectionId: string | null,
    beforeConversationId?: string | null,
  ) {
    await this.authorize();
    const { unpinned, reopened } = await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, this.workspaceId, this.userId);
      if (sectionId) {
        const section = await tx.chatSection.findFirst({
          where: { ...this.scope, id: sectionId },
          select: { id: true },
        });
        if (!section) throw new AppError("NOT_FOUND");
      }
      await lockConversation(tx, conversationId);
      const member = await tx.conversationMember.findFirst({
        where: {
          ...this.scope,
          conversationId,
          leftAt: null,
          conversation: {
            archivedAt: null,
            OR: [
              visibleChannelWhere(this.workspaceId, { userId: this.userId }),
              viewerDirectConversationWhere(this.userId),
            ],
          },
        },
        select: { id: true, hiddenAt: true, conversation: { select: { channelName: true } } },
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
        if (members.length === 1) {
          await tx.conversationMember.update({
            where: { id: members[0]!.id },
            data: { chatSectionSortOrder: 0 },
          });
        } else if (members.length > 1) {
          const updates = members
            .map((entry, sortOrder) => ({ id: entry.id, sortOrder }))
            .sort((a, b) => a.id.localeCompare(b.id));
          await tx.$executeRaw`UPDATE "conversation_members" AS m
            SET "chatSectionSortOrder" = v."sortOrder"
            FROM unnest(
              ${updates.map((row) => row.id)}::uuid[],
              ${updates.map((row) => row.sortOrder)}::int[]
            ) AS v("id", "sortOrder")
            WHERE m."id" = v."id"`;
        }
        await tx.chatSection.update({ where: { id: sectionId }, data: { collapsed: false } });
      }
      const unpinned = await setConversationPin(
        tx,
        { ...this.scope, conversationId, memberId: member.id },
        false,
      );
      const opened =
        member.conversation.channelName === null
          ? REALTIME_EVENTS.dmOpened
          : REALTIME_EVENTS.channelOpened;
      return { unpinned, reopened: member.hiddenAt ? opened : undefined };
    });
    await this.announceChanged();
    if (reopened)
      await announceViewerEvent(this.realtime, {
        userIds: [this.userId],
        event: { type: reopened, workspaceId: this.workspaceId, conversationId },
      });
    if (unpinned)
      await announceViewerEvent(this.realtime, {
        userIds: [this.userId],
        event: { type: REALTIME_EVENTS.prefChanged, workspaceId: this.workspaceId, name: "pins" },
      });
  }
}
