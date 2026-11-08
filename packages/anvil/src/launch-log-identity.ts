/** The launch identity the Daemon declares in the environment it spawns an Agent process with.
 * The Agent id is the same variable an Agent's own tools read (`agentRuntimeContextEnvironment`);
 * the launch id names the Daemon launch the process belongs to — `COFORGE_AGENT_LAUNCH_TAG` beside
 * it is per process, minted for the descendant sweep, not per launch. */
const AGENT_ID_ENV = "COFORGE_CURRENT_AGENT_ID";
const LAUNCH_ID_ENV = "COFORGE_AGENT_LAUNCH_ID";

/**
 * What a provider process's log records say about whose process it is, read from the environment
 * the process was spawned with: empty for the catalog, auth and usage processes a Daemon runs for
 * no single Agent. The process records carry them, so a stall repair can be reconstructed later
 * from what the provider process itself reported (task #698).
 */
export function launchLogProperties(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const agentId = environment[AGENT_ID_ENV]?.trim();
  const launchId = environment[LAUNCH_ID_ENV]?.trim();
  return {
    ...(agentId ? { agent_id: agentId } : {}),
    ...(launchId ? { launch_id: launchId } : {}),
  };
}
