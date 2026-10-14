import { sanitizeWorkspaceMemoryFailure } from "./errors";
import {
  applyWorkspaceMemoryCommand,
  type PrototypeGate,
  type WorkspaceMemoryProfile,
} from "./profile";

export const WORKSPACE_MEMORY_AGENT_HANDLE = "memory";
export const WORKSPACE_MEMORY_AGENT_DISPLAY_NAME = "Memory";

/** One Computer owned by the Memory Agent's owner and linked to the Workspace. */
export type WorkspaceComputerLink = {
  linkId: string;
  computerId: string;
  linkedAt: Date;
};

/**
 * The owner's earliest Computer in the Workspace. `Computer` has no creation time,
 * so order is the Workspace link time, then the link id.
 */
export function earliestLinkedComputerId(links: readonly WorkspaceComputerLink[]): string | null {
  let earliest: WorkspaceComputerLink | null = null;
  for (const link of links) {
    if (
      !earliest ||
      link.linkedAt.getTime() < earliest.linkedAt.getTime() ||
      (link.linkedAt.getTime() === earliest.linkedAt.getTime() && link.linkId < earliest.linkId)
    ) {
      earliest = link;
    }
  }
  return earliest?.computerId ?? null;
}

/** An agent that already has a Computer keeps it. An unbound agent takes the earliest link. */
export function computerIdToBind(
  currentComputerId: string | null,
  links: readonly WorkspaceComputerLink[],
): string | null {
  if (currentComputerId) return null;
  return earliestLinkedComputerId(links);
}

/**
 * Profile write for a newly provisioned Memory Agent. An already-`openviking` profile is
 * left alone, so a later agent does not move the activation cursor. A closed prototype
 * gate keeps `desired` at `off` and records `prototype_disabled`.
 */
export function profileForNewMemoryAgent(
  current: WorkspaceMemoryProfile,
  now: Date,
  gate: PrototypeGate,
): WorkspaceMemoryProfile {
  if (current.desired === "openviking") return current;
  if (!gate.prototypeEnabled) {
    return {
      ...current,
      sanitizedFailure: sanitizeWorkspaceMemoryFailure("prototype_disabled"),
    };
  }
  const applied = applyWorkspaceMemoryCommand(
    current,
    { type: "select_desired", desired: "openviking", at: now },
    gate,
  );
  return applied.ok ? applied.profile : { ...current, sanitizedFailure: applied.failure };
}

/**
 * The sweep retries a recorded prototype rejection once the gate allows it. Membership
 * is not required. A profile that is already `openviking`, or that failed for another
 * reason, is left alone.
 */
export function retriedOpenVikingProfile(
  current: WorkspaceMemoryProfile,
  now: Date,
  gate: PrototypeGate,
): WorkspaceMemoryProfile | null {
  if (!gate.prototypeEnabled) return null;
  if (current.desired !== "off") return null;
  if (current.sanitizedFailure?.code !== "prototype_disabled") return null;
  const applied = applyWorkspaceMemoryCommand(
    current,
    { type: "select_desired", desired: "openviking", at: now },
    gate,
  );
  return applied.ok && applied.profile !== current ? applied.profile : null;
}
