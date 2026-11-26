/**
 * Wire contract for `coforge version`'s local-only Daemon query. Unlike the
 * Manual routes, `GET /api/agent/v1/version` never reaches Web/backend: the Daemon answers it
 * directly from the live process that is already running, which is the whole point of the command
 * ("what is the live Daemon actually running", not a cloud-recorded fact).
 */

import { z } from "zod";

/** Response for `GET /api/agent/v1/version`, answered entirely by the local Daemon's Agent proxy. */
export type AgentVersionResponse = {
  ok: true;
  /** The live Daemon process's own version (`COFORGE_DAEMON_VERSION`). */
  daemonVersion: string;
  /** The Computer executable version the Daemon was launched with, when known. The Computer
   * bundles both the Computer and Daemon package roles into one executable, so this
   * is the Computer's own version, not a separate installation. */
  computerVersion?: string;
  /** The live Daemon process id, for diagnostics. */
  daemonPid?: number;
  /** When this Workspace's Daemon runtime started, in epoch milliseconds. */
  startedAt?: number;
};

const agentVersionResponseSchema = z.object({
  ok: z.literal(true),
  daemonVersion: z.string(),
  computerVersion: z.string().optional(),
  daemonPid: z.number().optional(),
  startedAt: z.number().optional(),
});

export function decodeAgentVersionResponse(value: unknown): AgentVersionResponse {
  const parsed = agentVersionResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent version response");
  const { ok, daemonVersion, computerVersion, daemonPid, startedAt } = parsed.data;
  return {
    ok,
    daemonVersion,
    ...(computerVersion !== undefined ? { computerVersion } : {}),
    ...(daemonPid !== undefined ? { daemonPid } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}
