import { z } from "zod";

import { LABEL_DESCRIPTION_MAX } from "#src/features/tasks/label-settings-model";
import { LABEL_COLORS, LABEL_NAME_MAX } from "#src/server/tasks/labels.server";

/**
 * What the web's `updateTaskLabel` takes (labels.functions.ts): a rename, a recolor, what the label
 * is for (empty or null clears it; Settings → Labels, task #508) or an archive. Nothing else: the
 * server's other inputs (a group) are not the page's to send. Here, not in the functions file, so
 * the browser bundle never reaches the server modules it is built from.
 */
export const labelUpdateInput = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(LABEL_NAME_MAX).optional(),
    color: z.enum(LABEL_COLORS).optional(),
    description: z.string().trim().max(LABEL_DESCRIPTION_MAX).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
