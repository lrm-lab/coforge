import { z } from "zod";

import { checkPersonName } from "#src/features/profiles/person-name";

/**
 * A person's name by the one rule (`person-name.ts`), shared with the name asked at first
 * sign-in. The problem is the issue's own message (`empty`, `too_long`, `refused`), for a page to
 * word.
 */
function personName(value: string, context: z.RefinementCtx) {
  const checked = checkPersonName(value);
  if (checked.ok) return checked.name;
  context.issues.push({ code: "custom", message: checked.problem, input: value });
  return z.NEVER;
}

/** The name, required: the one name teammates see. */
export const displayNameSchema = z.string().transform(personName);

export const saveUserProfileInputSchema = z.object({
  displayName: displayNameSchema,
  description: z.string().trim().max(280),
});
