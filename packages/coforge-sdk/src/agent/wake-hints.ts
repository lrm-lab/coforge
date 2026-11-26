import { z } from "zod";

export const WAKE_HINT_FLAGS = ["mention", "non_member_mention", "dm", "thread", "task"] as const;
export type WakeHintFlag = (typeof WAKE_HINT_FLAGS)[number];

export const WAKE_HINT_CHANNEL_TYPES = ["channel", "dm", "task", "attachment"] as const;
export type WakeHintChannelType = (typeof WAKE_HINT_CHANNEL_TYPES)[number];

export const WAKE_HINT_SENDER_TYPES = ["human", "agent", "system"] as const;
export type WakeHintSenderType = (typeof WAKE_HINT_SENDER_TYPES)[number];

export type WakeHint = {
  target: string | null;
  channelId: string;
  channelType: WakeHintChannelType;
  pendingCount: number;
  firstPendingMsgId: string;
  latestMsgId: string;
  latestSeq: string;
  latestSenderName: string | null;
  latestSenderType: WakeHintSenderType;
  flags: WakeHintFlag[];
};

export type WakeHintsResponse = { hints: WakeHint[] };

const wakeHintSchema = z.object({
  target: z.string().nullable(),
  channelId: z.string(),
  channelType: z.enum(WAKE_HINT_CHANNEL_TYPES),
  pendingCount: z.int().min(0),
  firstPendingMsgId: z.string(),
  latestMsgId: z.string(),
  latestSeq: z.string(),
  latestSenderName: z.string().nullable(),
  latestSenderType: z.enum(WAKE_HINT_SENDER_TYPES),
  flags: z.array(z.enum(WAKE_HINT_FLAGS)),
});

const wakeHintsEnvelopeSchema = z.object({
  hints: z.array(z.unknown()),
});

export function decodeWakeHint(value: unknown): WakeHint {
  const parsed = wakeHintSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid wake hint");
  return parsed.data;
}

export function decodeWakeHints(value: unknown): WakeHint[] {
  const parsed = wakeHintsEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid wake hints");
  return parsed.data.hints.map(decodeWakeHint);
}
