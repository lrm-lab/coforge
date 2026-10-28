import type { Prisma } from "#src/generated/prisma/client";

/**
 * Whether a Computer must stay off Workspace member lists for this viewer.
 * Only another person's account default cloud computer is hidden; extras and
 * local Computers stay listed for every member.
 */
export function defaultCloudComputerHiddenFromViewer(
  viewerId: string,
  computer: { kind: string; cloudSlot: string | null; ownerId: string },
): boolean {
  return (
    computer.kind === "cloud" && computer.cloudSlot === "default" && computer.ownerId !== viewerId
  );
}

/** Prisma filter for Computers a Workspace member may see on list and search. */
export function listedWorkspaceComputerWhere(viewerId: string): Prisma.ComputerWhereInput {
  return {
    deletedAt: null,
    OR: [{ ownerId: viewerId }, { kind: "local" }, { kind: "cloud", cloudSlot: "extra" }],
  };
}
