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

/** How a section orders its rows: the member's drag order, latest message first, or by name. */
export const chatSectionSortModes = ["manual", "recent", "alpha"] as const;
export type ChatSectionSortMode = (typeof chatSectionSortModes)[number];

export const chatSectionPatch = chatSectionFields.partial().extend({
  collapsed: z.boolean().optional(),
  sortMode: z.enum(chatSectionSortModes).optional(),
});

export type ChatSection = {
  id: string;
  name: string;
  emoji: string | null;
  collapsed: boolean;
  sortOrder: number;
  sortMode: ChatSectionSortMode;
  conversationIds: string[];
};
