import { z } from "zod";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

/** A label as its own change event carries it: everything the picker shows. */
export type LabelEventRef = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  group: { id: string; name: string; selection: string } | null;
  archived: boolean;
};

/**
 * A Workspace label's own change: its new name, color, description, group or archived state, or
 * that it was deleted. A Task's label membership rides `task.changed.v1` instead; this event is for
 * the picker and every card that already shows the label by id.
 */
export type LabelChangedEvent = {
  type: "label.changed.v1";
  workspaceId: string;
  /** The label after the write; null when it was deleted. */
  label: LabelEventRef | null;
  /** The deleted label's id; set only for a delete. */
  deletedLabelId?: string;
};

/** A label group's own change: its new name and selection, or that it was deleted. */
export type LabelGroupChangedEvent = {
  type: "label.group.changed.v1";
  workspaceId: string;
  group: { id: string; name: string; selection: string } | null;
  deletedGroupId?: string;
};

const labelRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  description: z.string().nullable(),
  group: z
    .object({ id: z.string().min(1), name: z.string().min(1), selection: z.string() })
    .nullable(),
  archived: z.boolean(),
});

const labelChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.labelChanged),
  workspaceId: z.string().min(1),
  label: labelRef.nullable(),
  deletedLabelId: z.string().min(1).optional(),
});

const groupRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  selection: z.string(),
});

const labelGroupChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.labelGroupChanged),
  workspaceId: z.string().min(1),
  group: groupRef.nullable(),
  deletedGroupId: z.string().min(1).optional(),
});

/** The event, or undefined for any other publication on the channel. */
export function decodeLabelChangedEvent(value: unknown): LabelChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.labelChanged) return undefined;
  const parsed = labelChangedEvent.safeParse(data);
  return parsed.success ? (parsed.data as LabelChangedEvent) : undefined;
}

/** The group event, or undefined for any other publication on the channel. */
export function decodeLabelGroupChangedEvent(value: unknown): LabelGroupChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== REALTIME_EVENTS.labelGroupChanged) return undefined;
  const parsed = labelGroupChangedEvent.safeParse(data);
  return parsed.success ? (parsed.data as LabelGroupChangedEvent) : undefined;
}
