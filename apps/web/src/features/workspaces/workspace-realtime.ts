import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import { z } from "zod";

/**
 * The Workspace was deleted. Published on its `chat:workspace:<workspace_id>` channel
 * (`workspaceConversationChannel`), which every open page of the Workspace holds, so each of them
 * leaves it for `/`. Like the other signals it carries only the id.
 */
export type WorkspaceDeletedEvent = { type: "workspace.deleted.v1"; workspaceId: string };

const workspaceDeletedEvent = z.object({
  type: z.literal("workspace.deleted.v1"),
  workspaceId: z.string().min(1),
});

/** The event, or undefined for any other publication on the channel (most are messages). */
export function decodeWorkspaceDeletedEvent(value: unknown): WorkspaceDeletedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (publicationType(data) !== "workspace.deleted.v1") return undefined;
  const parsed = workspaceDeletedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the Workspace offers changed (an owner or admin switched an experiment), published on the
 * same channel. A page that shows or hides something by it reads its features again; the event
 * carries only the id, so it says nothing about which switch moved.
 */
export type WorkspaceFeaturesChangedEvent = {
  type: "workspace.features.changed.v1";
  workspaceId: string;
};

const workspaceFeaturesChangedEvent = z.object({
  type: z.literal("workspace.features.changed.v1"),
  workspaceId: z.string().min(1),
});

export function decodeWorkspaceFeaturesChangedEvent(
  value: unknown,
): WorkspaceFeaturesChangedEvent | undefined {
  const data = publicationDataOrUndefined(value);
  if (
    !data ||
    typeof data !== "object" ||
    Reflect.get(data, "type") !== "workspace.features.changed.v1"
  )
    return undefined;
  const parsed = workspaceFeaturesChangedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
