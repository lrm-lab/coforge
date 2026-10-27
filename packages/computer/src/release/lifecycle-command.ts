import { Command, CommanderError } from "commander";
import type { DaemonServiceDefinition } from "@lrm/coforge-daemon";

import { currentServiceDefinition } from "#src/daemon-service/daemon-host";
import { COFORGE_COMPUTER_VERSION } from "#src/version";
import {
  LIFECYCLE_COMMANDS,
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LIFECYCLE_PROTOCOL,
  type LifecycleError,
  type LifecycleServiceDefinition,
  type LifecycleStatus,
} from "./installer-contract";
import {
  createSupervisorStatusReader,
  resolveSupervisorPaths,
  type SupervisorStatusReader,
} from "./supervisor-status";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

/**
 * `coforge-computer __lifecycle <command>`: the versioned JSON surface through which the
 * separately released installer reads this Computer. Every call prints exactly one JSON object on
 * stdout and nothing else, so the installer never parses human text; the exit status is one of
 * `LIFECYCLE_EXIT_CODE`. `service-definition` prints the service file the installer writes before it
 * starts the supervisor service, rendered by the daemon host itself. Every command only reads: the installer also probes a candidate binary
 * that has never run.
 */
export async function runLifecycleCommand(
  args: readonly string[],
  ports: Partial<LifecyclePorts> = {},
): Promise<number> {
  return runCommand(args, {
    reader: createSupervisorStatusReader(resolveSupervisorPaths()),
    serviceDefinition: currentServiceDefinition,
    write: (line) => process.stdout.write(`${line}\n`),
    ...ports,
  });
}

/** What the commands read, replaceable so a test can run them for any platform. */
export type LifecyclePorts = {
  reader: SupervisorStatusReader;
  serviceDefinition(): DaemonServiceDefinition;
  /** Receives each output line without its newline. */
  write(line: string): unknown;
};

async function runCommand(args: readonly string[], ports: LifecyclePorts): Promise<number> {
  const { reader } = ports;
  const print = (value: object) => ports.write(JSON.stringify(value));
  // A machine interface: no help or version output, and every Commander failure is a usage error.
  const program = new Command()
    .name("coforge-computer __lifecycle")
    .helpOption(false)
    .helpCommand(false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.command("protocol").action(() => {
    print({
      lifecycle_protocol: LIFECYCLE_PROTOCOL,
      version: COFORGE_COMPUTER_VERSION,
      commands: LIFECYCLE_COMMANDS,
    });
  });
  program.command("service-definition").action(() => {
    const { manager, contents } = ports.serviceDefinition();
    print({
      lifecycle_protocol: LIFECYCLE_PROTOCOL,
      version: COFORGE_COMPUTER_VERSION,
      manager,
      contents,
    } satisfies LifecycleServiceDefinition);
  });
  program.command("status").action(async () => {
    const status = await reader.status();
    print({
      lifecycle_protocol: LIFECYCLE_PROTOCOL,
      version: COFORGE_COMPUTER_VERSION,
      supervisor: status.supervisor,
      bindings: status.bindings.map((binding) => ({
        binding_id: binding.bindingId,
        enabled: binding.enabled,
        running: binding.running,
        process_id: binding.processId,
      })),
      healthy: status.problems.length === 0,
      problems: status.problems.map(({ code, bindingId, message }) => ({
        code,
        ...(bindingId ? { binding_id: bindingId } : {}),
        message,
      })),
    } satisfies LifecycleStatus);
  });
  try {
    await program.parseAsync(args, { from: "user" });
    return LIFECYCLE_EXIT_CODE.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      print(lifecycleError(LIFECYCLE_ERROR_CODE.USAGE, error.message));
      return LIFECYCLE_EXIT_CODE.USAGE;
    }
    print(lifecycleError(LIFECYCLE_ERROR_CODE.FAILED, thrownMessage(error)));
    return LIFECYCLE_EXIT_CODE.FAILED;
  }
}

function lifecycleError(code: string, message: string): LifecycleError {
  return { lifecycle_protocol: LIFECYCLE_PROTOCOL, ok: false, code, message };
}
