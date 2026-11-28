import { humanLabel, UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";

export type ComputerRuntimeOwner = {
  ownedByCurrentUser?: boolean;
  creator?: { displayName?: string | null } | null;
};

export function publicRuntimesOwnerName(
  computer: ComputerRuntimeOwner | undefined,
): string | undefined {
  if (!computer || computer.ownedByCurrentUser !== false || !computer.creator) return undefined;
  const resolved = humanLabel(computer.creator);
  return resolved === UNNAMED_PERSON_NAME ? m.computer_detail_creator_unnamed() : resolved;
}

export function publicRuntimesHint(computer: ComputerRuntimeOwner | undefined): string | undefined {
  const owner = publicRuntimesOwnerName(computer);
  return owner ? m.computer_runtimes_owner_public({ owner }) : undefined;
}
