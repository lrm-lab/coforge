/** The environment variable carrying one Agent launch's process tag (task #673). Every process an
 * Agent launch spawns inherits it, across setsid, double-fork and reparenting to launchd, so a
 * later sweep can find descendants that escaped the process-group cleanup. The value is
 * `<agentId>:<launchToken>`: the Agent id scopes the sweep, and the per-process-launch token
 * keeps a replacement launch's processes safe while older launches' strays are collected. It is
 * opaque — it grants nothing without the Daemon's own state — so env sanitizers may preserve it. */
export const AGENT_LAUNCH_TAG_ENV = "COFORGE_AGENT_LAUNCH_TAG";

/** Removes the launch tag from a CoForge process's own environment. Computer, Daemon and
 * Supervisor entries call this first: a process started from an Agent's shell (an upgrade, a
 * restart, a foreground start) would otherwise inherit the tag and be collected as one of that
 * Agent's strays, and would pass it on to everything it spawns. */
export function stripAgentLaunchTagEnv(env: NodeJS.ProcessEnv = Bun.env): void {
  delete env[AGENT_LAUNCH_TAG_ENV];
}

/** Builds the tag value for one process launch. `token` must be unique per launch (a UUID), never
 * the reused launch identity: a wake reuses `launchId`, which would make a new launch's processes
 * indistinguishable from the strays it is meant to sweep. */
export function agentLaunchTag(agentId: string, token: string): string {
  return `${agentId}:${token}`;
}

/** The tag's shape: two UUIDs joined by a colon. Matching this exact shape keeps a process whose
 * command line merely mentions the variable name from being collected. */
export const AGENT_LAUNCH_TAG_VALUE = /[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}/;
