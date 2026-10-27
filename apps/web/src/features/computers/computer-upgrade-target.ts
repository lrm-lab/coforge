import type { ComputerUpgradeStatus, ComputerUpgradeTarget } from "./computer.schemas";

/** Which detail row owns an in-flight upgrade, from the server status when present. */
export function computerUpgradeTarget(
  status: ComputerUpgradeStatus | null | undefined,
): ComputerUpgradeTarget | undefined {
  return status && "target" in status ? status.target : undefined;
}
