import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/errors";

export type HostedRestartCaller = {
  workspaceId?: string;
  computerId?: string;
};

type ReadBindings = () => Promise<ManagedRuntimeIdentity[]>;

function hostingSession(): never {
  throw new CliError(
    "RESTART_HOSTING_AGENT_SESSION",
    "This restart would interrupt the current Agent session.",
    "Run the restart from a normal terminal outside this Agent session.",
  );
}

function unverifiedTarget(): never {
  throw new CliError(
    "RESTART_TARGET_UNVERIFIED",
    "Could not confirm that the restart targets a different Computer from the current Agent session.",
    "Run the restart from a normal terminal outside this Agent session.",
  );
}

function mayHostCaller(binding: ManagedRuntimeIdentity, caller: HostedRestartCaller): boolean {
  return (
    (!caller.workspaceId || caller.workspaceId === binding.workspaceId) &&
    (!caller.computerId || !binding.computerId || caller.computerId === binding.computerId)
  );
}

export async function assertWorkspaceRestartTarget(
  caller: HostedRestartCaller,
  target: string | undefined,
  readBindings: ReadBindings,
): Promise<void> {
  if (target && caller.workspaceId && target !== caller.workspaceId) return;
  const bindings = await readBindings().catch(unverifiedTarget);
  if (
    bindings.some(
      (binding) =>
        (target ? binding.workspaceId === target : binding.enabled) &&
        mayHostCaller(binding, caller),
    )
  )
    hostingSession();
}

export async function assertSupervisorRestartTarget(
  caller: HostedRestartCaller,
  readTarget: () => Promise<{
    bindings: ManagedRuntimeIdentity[];
    coordinatorPid: number | undefined;
  }>,
  verifyServiceTarget: (coordinatorPid: number | undefined) => Promise<boolean>,
): Promise<void> {
  const { bindings, coordinatorPid } = await readTarget().catch(unverifiedTarget);
  if (bindings.some((binding) => mayHostCaller(binding, caller))) hostingSession();
  if (
    !caller.computerId ||
    !bindings.length ||
    bindings.some((binding) => !binding.computerId || binding.computerId === caller.computerId) ||
    !(await verifyServiceTarget(coordinatorPid).catch(() => false))
  )
    unverifiedTarget();
}
