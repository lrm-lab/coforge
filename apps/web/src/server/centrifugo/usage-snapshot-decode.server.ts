import { RESET_CREDITS_MAX, utf8Decoder, type RuntimeMetadata } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import type { UsageSnapshot } from "./usage-cache.server";

function hasNoControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

const parseableInstant = (minLength = 0) =>
  z
    .string()
    .min(minLength)
    .max(100)
    .refine((value) => !Number.isNaN(Date.parse(value)));

const officialText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= max)
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional();

const bucketStatusSchema = z
  .enum(["ok", "available", "limit_reached", "rate-limited", "parse_unavailable"])
  .transform((status): "ok" | "limit_reached" | "parse_unavailable" =>
    status === "available" ? "ok" : status === "rate-limited" ? "limit_reached" : status,
  );

const quotaLevelSchema = z.enum(["ok", "warning", "near_exhausted", "exhausted"]);

const usageWindowSchema = z
  .object({
    windowDurationMinutes: z.number().positive(),
    resetsAt: parseableInstant().optional(),
    usedPercent: z.number().min(0).max(100).optional(),
    id: z.string().min(1).max(100).optional().catch(undefined),
    status: bucketStatusSchema.optional(),
    quotaLevel: quotaLevelSchema.optional().catch(undefined),
  })
  .transform(({ windowDurationMinutes, resetsAt, usedPercent, id, status, quotaLevel }) => ({
    windowDurationMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(quotaLevel !== undefined ? { quotaLevel } : {}),
  }));

const officialBucketSchema = z
  .object({
    id: officialText(100),
    name: officialText(200),
    description: officialText(2_000),
    window: officialText(40),
    remainingFraction: z.number().min(0).max(1).optional(),
    usedPercent: z.number().min(0).max(100).optional(),
    status: bucketStatusSchema.optional(),
    windowDurationMinutes: z.number().positive().optional(),
    resetsAt: parseableInstant(1).optional(),
  })
  .transform(
    ({
      id,
      name,
      description,
      window,
      remainingFraction,
      usedPercent,
      status,
      windowDurationMinutes,
      resetsAt,
    }) => ({
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(window !== undefined ? { window } : {}),
      ...(remainingFraction !== undefined ? { remainingFraction } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(windowDurationMinutes !== undefined ? { windowDurationMinutes } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    }),
  );

const officialGroupSchema = z
  .object({
    name: officialText(200),
    description: officialText(2_000),
    buckets: z.array(officialBucketSchema).min(1).max(12),
  })
  .transform(({ name, description, buckets }) => ({
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    buckets,
  }));

const creditBalanceSchema = z
  .union([
    z.null().transform(() => undefined),
    z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0 && value.length <= 40),
  ])
  .optional();

const creditsSchema = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: creditBalanceSchema,
  })
  .transform(({ hasCredits, unlimited, balance }) => ({
    hasCredits,
    unlimited,
    ...(balance !== undefined ? { balance } : {}),
  }));

const creditUsageSchema = z
  .object({
    used: z.number().min(0),
    limit: z.number().positive(),
    overage: z.number().min(0),
  })
  .refine(({ used, limit }) => used <= limit);

const accountLabelSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.includes("*") && hasNoControlChars(value));

const healthSchema = z.enum(["ok", "rate_limited", "reauth_required", "unsupported", "error"]);

const usageSnapshotSchema = z
  .object({
    provider: z.string(),
    planType: z.string().max(100).optional(),
    primary: usageWindowSchema.optional(),
    secondary: usageWindowSchema.optional(),
    officialGroups: z.array(officialGroupSchema).min(1).max(12).optional(),
    officialDescription: officialText(2_000),
    credits: creditsSchema.optional(),
    creditUsage: creditUsageSchema.optional(),
    resetCreditsAvailable: z.int().min(0).max(RESET_CREDITS_MAX).optional().catch(undefined),
    collectedAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)))
      .optional(),
    accountLabel: accountLabelSchema.optional(),
    health: healthSchema.optional(),
  })
  .refine((snapshot) => snapshot.creditUsage === undefined || snapshot.primary !== undefined);

/** A usage snapshot as a Computer reports it: checked field by field, so one malformed field
 * rejects the whole reading instead of reaching the cache. */
export function decodeUsageSnapshot(
  bytes: Uint8Array,
  expectedProvider: RuntimeMetadata["provider"],
): UsageSnapshot | undefined {
  if (bytes.byteLength > 16_384) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return undefined;
  }
  const parsed = usageSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.provider !== expectedProvider) return undefined;
  const {
    planType,
    primary,
    secondary,
    officialGroups,
    officialDescription,
    credits,
    creditUsage,
    resetCreditsAvailable,
    collectedAt,
    accountLabel,
    health,
  } = parsed.data;
  return {
    provider: expectedProvider,
    ...(planType !== undefined ? { planType } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    ...(officialGroups !== undefined ? { officialGroups } : {}),
    ...(officialDescription !== undefined ? { officialDescription } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(creditUsage !== undefined ? { creditUsage } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ...(health !== undefined ? { health } : {}),
  };
}
