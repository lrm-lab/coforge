import { z } from "zod";

export const chatSectionFields = z.object({
  name: z.string().trim().min(1).max(18),
  emoji: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .refine(
      (value) =>
        /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value) &&
        [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1,
    )
    .nullable(),
});

export const chatSectionPatch = chatSectionFields.partial().extend({
  collapsed: z.boolean().optional(),
});

export type ChatSection = {
  id: string;
  name: string;
  emoji: string | null;
  collapsed: boolean;
  sortOrder: number;
  conversationIds: string[];
};
