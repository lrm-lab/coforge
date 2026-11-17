import { isRecord } from "../internal";

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

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export function decodeWakeHint(value: unknown): WakeHint {
  if (
    !isRecord(value) ||
    !(value.target === null || typeof value.target === "string") ||
    typeof value.channelId !== "string" ||
    !isOneOf(WAKE_HINT_CHANNEL_TYPES, value.channelType) ||
    typeof value.pendingCount !== "number" ||
    !Number.isInteger(value.pendingCount) ||
    value.pendingCount < 0 ||
    typeof value.firstPendingMsgId !== "string" ||
    typeof value.latestMsgId !== "string" ||
    typeof value.latestSeq !== "string" ||
    !(value.latestSenderName === null || typeof value.latestSenderName === "string") ||
    !isOneOf(WAKE_HINT_SENDER_TYPES, value.latestSenderType) ||
    !Array.isArray(value.flags) ||
    !value.flags.every((flag) => isOneOf(WAKE_HINT_FLAGS, flag))
  )
    throw new Error("invalid wake hint");
  return {
    target: value.target,
    channelId: value.channelId,
    channelType: value.channelType,
    pendingCount: value.pendingCount,
    firstPendingMsgId: value.firstPendingMsgId,
    latestMsgId: value.latestMsgId,
    latestSeq: value.latestSeq,
    latestSenderName: value.latestSenderName,
    latestSenderType: value.latestSenderType,
    flags: value.flags as WakeHintFlag[],
  };
}

export function decodeWakeHints(value: unknown): WakeHint[] {
  if (!isRecord(value) || !Array.isArray(value.hints)) throw new Error("invalid wake hints");
  return value.hints.map(decodeWakeHint);
}
