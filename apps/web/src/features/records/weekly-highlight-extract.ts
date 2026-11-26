import { z } from "zod";
import { currentPersonPictureUrl, isPersonPicture } from "#src/lib/person-picture";

export type RecordAssistantPayload =
  | { kind: "offer-help-generate" }
  | { kind: "collect-plan"; reportId: string; year: number; week: number }
  | { kind: "collect-run"; runId: string }
  | {
      kind: "confirm-intent";
      intent: "collect-again" | "synthesize";
      reportId: string;
      year: number;
      week: number;
      /** Original user turn; forwarded into synthesizer wake on confirm. */
      userGuidance?: string;
    }
  | { kind: "intent-declined" }
  | {
      kind: "offer-send";
      year?: number;
      week?: number;
      /** e.g. `2026 W36 (08.31-09.04)` */
      weekTitle?: string;
      updatedAt?: string;
      recipients?: Array<{
        displayName: string;
        /** The recipient's user id, absent on a payload written before it was stored: the avatar
         * then resolves to the default cartoon person only when the stored URL is gone. */
        userId?: string;
        avatarUrl: string | null;
      }>;
      recipientTotal?: number;
    };

/** A stock portrait the cartoon people replaced (`/avatars/portrait-NN.webp`), still named by
 * payloads stored before. */
function isRetiredPortrait(url: string): boolean {
  return url.startsWith("/avatars/portrait-");
}

const optionalTrimmedString = z.string().trim().min(1).optional().catch(undefined);

const offerSendRecipientSchema = z
  .object({
    displayName: z.string().trim().min(1),
    userId: z.string().min(1).optional().catch(undefined),
    avatarUrl: z.string().optional().catch(undefined),
  })
  .transform(({ displayName, userId, avatarUrl }) => ({
    displayName,
    ...(userId ? { userId } : {}),
    avatarUrl:
      avatarUrl !== undefined && !isRetiredPortrait(avatarUrl)
        ? (currentPersonPictureUrl(avatarUrl) ?? (isPersonPicture(avatarUrl) ? null : avatarUrl))
        : null,
  }));

const recordAssistantPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer-help-generate") }),
  z.object({ kind: z.literal("intent-declined") }),
  z.object({
    kind: z.literal("collect-plan"),
    reportId: z.string(),
    year: z.number(),
    week: z.number(),
  }),
  z.object({
    kind: z.literal("collect-run"),
    runId: z.string(),
  }),
  z.object({
    kind: z.literal("confirm-intent"),
    intent: z.enum(["collect-again", "synthesize"]),
    reportId: z.string(),
    year: z.number(),
    week: z.number(),
    userGuidance: optionalTrimmedString,
  }),
  z.object({
    kind: z.literal("offer-send"),
    year: z.number().optional().catch(undefined),
    week: z.number().optional().catch(undefined),
    weekTitle: optionalTrimmedString,
    updatedAt: optionalTrimmedString,
    recipients: z
      .array(z.unknown())
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = offerSendRecipientSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      )
      .optional()
      .catch(undefined),
    recipientTotal: z.int().optional().catch(undefined),
  }),
]);

export function parseRecordAssistantPayload(value: unknown): RecordAssistantPayload | null {
  const parsed = recordAssistantPayloadSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.kind === "confirm-intent") {
    return {
      kind: data.kind,
      intent: data.intent,
      reportId: data.reportId,
      year: data.year,
      week: data.week,
      ...(data.userGuidance ? { userGuidance: data.userGuidance } : {}),
    };
  }
  if (data.kind === "offer-send") {
    return {
      kind: "offer-send",
      ...(data.year !== undefined ? { year: data.year } : {}),
      ...(data.week !== undefined ? { week: data.week } : {}),
      ...(data.weekTitle ? { weekTitle: data.weekTitle } : {}),
      ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
      ...(data.recipients && data.recipients.length > 0 ? { recipients: data.recipients } : {}),
      ...(data.recipientTotal !== undefined ? { recipientTotal: data.recipientTotal } : {}),
    };
  }
  return data;
}

/** Member accepts the assignee-side “help me generate” offer (E1 → E2). */
export function looksLikeMemberGenerateOfferAccept(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (/^(需要|好的|好|帮我生成|直接生成|需要帮忙)[!！。.?？]*$/i.test(text)) return true;
  return /需要.*(生成|帮忙)|帮我.*(生成|写周报)|直接生成/i.test(text);
}

/** User asks to open / re-open the Collect plan card. */
export function looksLikeCollectAgainRequest(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (
    /^(再采集|重新采集|再采一次|再采集一遍|重新采一遍|再跑一遍采集|再扫一遍)[!！。.?？]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /(再|重新|再来|再跑).{0,6}(采集|收集)|collect\s*(again|once more)|re-?collect/i.test(text);
}

/** User asks to synthesize the member report from ready collect packs. */
export function looksLikeSynthesizeWeeklyReportRequest(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (
    /^(整理周报|总结周报|生成周报|写周报|整理一下|总结一下|再整理一遍|重新整理)[!！。.?？]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /(整理|总结|合成).{0,6}周报|(根据|基于).{0,12}(采集包|证据|采集).{0,12}(整理|总结|写|生成)|synthesize|summarize.*(report|week)/i.test(
    text,
  );
}

/** Platform rule path for member report side chat (skip Agent LLM). */
export function looksLikeMemberReportRuleIntent(body: string): boolean {
  return (
    looksLikeMemberGenerateOfferAccept(body) ||
    looksLikeCollectAgainRequest(body) ||
    looksLikeSynthesizeWeeklyReportRequest(body)
  );
}

export type RecordSideChatSurface = "format" | "member-leader" | "member-assignee" | "plain";

/**
 * Collect/synthesize short-phrases only belong on the member-assignee surface.
 * On overview (`plain`) or template (`format`), the same text (e.g. 「重新整理」)
 * must reach the Agent DM instead of being swallowed as a no-op RecordComment.
 */
export function shouldUseMemberReportRulePath(
  surface: RecordSideChatSurface,
  body: string,
): boolean {
  return surface === "member-assignee" && looksLikeMemberReportRuleIntent(body);
}
