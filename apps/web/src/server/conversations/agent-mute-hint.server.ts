import type { PrismaClient } from "#src/generated/prisma/client";

type MuteHintDb = Pick<
  PrismaClient,
  "agentMuteHint" | "agentMessageDelivery" | "message" | "conversationMember"
>;

/** The window, message threshold and reply threshold for the one-time mute suggestion. */
export const MUTE_HINT_WINDOW_DAYS = Number(Bun.env.AGENT_MUTE_HINT_WINDOW_DAYS ?? 7);
export const MUTE_HINT_MESSAGES = Number(Bun.env.AGENT_MUTE_HINT_MESSAGES ?? 50);
export const MUTE_HINT_REPLIES = Number(Bun.env.AGENT_MUTE_HINT_REPLIES ?? 5);

export function muteHintText(target: string, messages: number, replies: number): string {
  return `This channel sent you ${messages} messages in the last ${MUTE_HINT_WINDOW_DAYS} days and you replied to ${replies}. If you don't need these updates, run \`coforge channel mute --target '${target}'\`.`;
}

/**
 * The one-time "you could mute this channel" suggestion. It counts the messages actually delivered
 * to and waking this Agent (its delivery rows, not every channel message), against the Agent's own
 * replies in the same window. One row per Agent and channel: once shown, adopted or ignored, never
 * again.
 */
export class AgentMuteHints {
  constructor(private readonly db: MuteHintDb) {}

  async forInbox(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    memberId?: string;
    target: string;
    muted: boolean;
    now?: Date;
  }): Promise<string | null> {
    if (input.muted) return null;
    const existing = await this.db.agentMuteHint.findUnique({
      where: {
        agentId_conversationId: {
          agentId: input.agentId,
          conversationId: input.conversationId,
        },
      },
      select: { outcome: true },
    });
    if (existing) return null;
    const memberId =
      input.memberId ??
      (
        await this.db.conversationMember.findUnique({
          where: {
            conversationId_agentId: {
              conversationId: input.conversationId,
              agentId: input.agentId,
            },
          },
          select: { id: true },
        })
      )?.id;
    if (!memberId) return null;
    const now = input.now ?? new Date();
    const since = new Date(now.getTime() - MUTE_HINT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [messages, replies] = await Promise.all([
      this.db.agentMessageDelivery.count({
        where: {
          agentId: input.agentId,
          conversationId: input.conversationId,
          createdAt: { gte: since },
          // A delivery with no reason is an ordinary channel delivery; a mention is not counted.
          OR: [{ reason: null }, { reason: { not: "mentioned" } }],
        },
      }),
      this.db.message.count({
        where: {
          conversationId: input.conversationId,
          senderMemberId: memberId,
          createdAt: { gte: since },
        },
      }),
    ]);
    if (messages < MUTE_HINT_MESSAGES || replies >= MUTE_HINT_REPLIES) return null;
    await this.db.agentMuteHint.create({
      data: {
        agentId: input.agentId,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        windowStart: since,
      },
    });
    return muteHintText(input.target, messages, replies);
  }

  /** The Agent muted the channel: the suggestion was adopted. */
  async adopt(agentId: string, conversationId: string) {
    await this.db.agentMuteHint.updateMany({
      where: { agentId, conversationId, outcome: "pending" },
      data: { outcome: "adopted" },
    });
  }

  /** A suggestion whose window passed without a mute was ignored. */
  async ignoreExpired(now = new Date()) {
    const before = new Date(now.getTime() - MUTE_HINT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await this.db.agentMuteHint.updateMany({
      where: { outcome: "pending", shownAt: { lt: before } },
      data: { outcome: "ignored" },
    });
  }
}
