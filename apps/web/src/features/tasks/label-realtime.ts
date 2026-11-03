import { z } from "zod";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

/**
 * A Workspace label's own change: its new name and color, or that it was deleted. A Task's label
 * membership rides `task.changed.v1` instead; this event is for the picker and every card that
 * already shows the label by id.
 */
export type LabelChangedEvent = {
  type: "label.changed.v1";
  workspaceId: string;
  /** The label after the write; null when it was deleted. */
  label: { id: string; name: string; color: string } | null;
  /** The deleted label's id; set only for a delete. */
  deletedLabelId?: string;
};

const label = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
});

const labelChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.labelChanged),
  workspaceId: z.string().min(1),
  label: label.nullable(),
  deletedLabelId: z.string().min(1).optional(),
});

/** The event, or undefined for any other publication on the channel. */
export function decodeLabelChangedEvent(value: unknown): LabelChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.labelChanged) return undefined;
  const parsed = labelChangedEvent.safeParse(data);
  return parsed.success ? (parsed.data as LabelChangedEvent) : undefined;
}
