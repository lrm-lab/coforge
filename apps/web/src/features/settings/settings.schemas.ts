import { z } from "zod";

import { TIME_FORMATS } from "#src/lib/time-format";

export const saveDateTimePreferencesInputSchema = z
  .object({
    timeZone: z.string().nullish(),
    timeFormat: z.enum(TIME_FORMATS).nullish(),
  })
  .refine((value) => value.timeZone !== undefined || value.timeFormat !== undefined);

export type DateTimePreferenceUpdate = z.infer<typeof saveDateTimePreferencesInputSchema>;

export const saveLanguagePreferencesInputSchema = z.object({
  language: z.enum(["en", "zh-CN"]).nullable(),
});

export const recordObservedTimeZoneInputSchema = z.object({
  timeZone: z.string().min(1).max(64),
});
