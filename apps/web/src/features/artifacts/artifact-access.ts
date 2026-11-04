import { useState } from "react";

import { useTaskAssignmentAccess } from "#src/features/tasks/use-task-assignment-access";
import type { ArtifactActorRef } from "./artifact-queries";

/**
 * Who can see an artifact (task #514, Frank: two levels, no public link): the people who can read
 * the conversation it lives in (the default), or every member of the Workspace.
 */
export type ArtifactAccess = "conversation" | "workspace";

/**
 * An artifact's access and whether the viewer may change it.
 *
 * STAND-IN until task #529: the level lives in this page only and starts at the default; who may
 * change it is its human author or a Workspace owner or admin (the rule #529 enforces also lets an
 * Agent's owner change what the Agent made). When #529 lands this becomes its read and its write;
 * nothing else changes.
 */
export function useArtifactAccess({
  author,
  viewerId,
}: {
  author: ArtifactActorRef | undefined;
  viewerId: string;
}) {
  const [access, setAccess] = useState<ArtifactAccess>("conversation");
  const { canAssignOthers: admin } = useTaskAssignmentAccess();
  const authored = author != null && "userId" in author && author.userId === viewerId;
  return { access, canChange: authored || admin, change: setAccess };
}
