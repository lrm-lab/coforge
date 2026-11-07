import type { Credential } from "#src/login";
import type { ComputerConfig } from "#src/local-config";
import { CliError, setupError } from "#src/errors";
import type { ComputerMetadataProvider, SetupRosterPort } from "./computer-setup";

export type ComputerIdentityPlan = {
  machineId: string;
  adoptComputerId?: string;
  mode: "adopted" | "fresh" | "registered";
};

export async function planComputerIdentity(input: {
  machineId?: string;
  fresh?: boolean;
  yes?: boolean;
  workspaceSlug?: string;
  serverUrl: string;
  credential: Credential;
  metadata: Awaited<ReturnType<ComputerMetadataProvider["get"]>>;
  config: Pick<ComputerConfig, "loadRegistration">;
  roster?: SetupRosterPort;
  onStage?: (stage: string, detail?: Record<string, string>) => void;
}): Promise<ComputerIdentityPlan> {
  const explicitMachineId = input.machineId?.trim();
  if (input.machineId !== undefined && !explicitMachineId)
    throw setupError("SETUP_MACHINE_INVALID", "The --machine value cannot be empty.");
  const localRegistration = await loadRegistration(input);
  let machineId = explicitMachineId ?? input.metadata.machineId;
  let adoptComputerId: string | undefined;
  let mode: ComputerIdentityPlan["mode"] = "registered";
  const roster = async () => {
    if (!input.roster)
      throw setupError(
        "SETUP_ROSTER_UNAVAILABLE",
        "The server cannot list Computers for adoption in this build.",
      );
    try {
      return await input.roster.list(input.serverUrl, input.credential);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError("SETUP_ROSTER_FAILED", "The server Computer roster could not be read.");
    }
  };
  const select = (candidate: Awaited<ReturnType<NonNullable<SetupRosterPort["list"]>>>[number]) => {
    machineId = candidate.machineId;
    adoptComputerId = candidate.computerId;
    mode = "adopted";
    input.onStage?.("candidate", {
      computerId: candidate.computerId,
      machineId: candidate.machineId,
      displayName: candidate.displayName,
    });
    if (!localRegistration)
      input.onStage?.("warning", {
        message: "local registration missing; adopting the server Computer without local detach",
      });
  };

  if (explicitMachineId) {
    const candidate = (await roster()).find(
      (value) => value.computerId === explicitMachineId || value.machineId === explicitMachineId,
    );
    if (!candidate)
      throw setupError(
        "SETUP_MACHINE_NOT_FOUND",
        `No Computer owned by this account matches '${explicitMachineId}'.`,
      );
    select(candidate);
    if (localRegistration?.computerId && localRegistration.computerId !== candidate.computerId)
      throw setupError(
        "SETUP_ADOPTION_CONFLICT",
        `Local Workspace '${input.workspaceSlug}' is attached to another Computer; refusing to replace it implicitly.`,
      );
  } else if (input.fresh) {
    if (localRegistration && !input.yes)
      throw setupError(
        "SETUP_CONFIRMATION_REQUIRED",
        "Fresh setup would replace the local Workspace binding; confirmation is required.",
      );
    machineId = `fresh:${crypto.randomUUID()}`;
    mode = "fresh";
    input.onStage?.("fresh", { machineId });
  } else if (!localRegistration && input.roster && input.workspaceSlug) {
    const candidates = await roster();
    const matches = candidates.filter((value) => value.machineId === input.metadata.machineId);
    if (matches.length === 1) select(matches[0]!);
    else if (candidates.length > 0)
      throw setupError(
        "SETUP_MACHINE_NOT_FOUND",
        "Local Computer evidence does not match an owned server Computer; choose --machine <id> or --fresh.",
      );
  }
  return { machineId, adoptComputerId, mode };
}

async function loadRegistration(input: {
  workspaceSlug?: string;
  config: Pick<ComputerConfig, "loadRegistration">;
}): Promise<
  Awaited<ReturnType<NonNullable<ComputerConfig["loadRegistration"]>>> | null | undefined
> {
  if (!input.config.loadRegistration || !input.workspaceSlug) return undefined;
  try {
    return await input.config.loadRegistration(input.workspaceSlug);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw setupError(
      "SETUP_ALREADY_ATTACHED_READ_FAILED",
      "The local Workspace registrations could not be read.",
    );
  }
}
