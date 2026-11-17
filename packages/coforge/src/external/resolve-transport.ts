import { profileNotLoggedInError } from "./refusal";
import type { AgentProfile, ProfileStore } from "./profile-store";

export type AgentTransportTarget =
  | { mode: "daemon"; socketPath: string; context: string; proxyUrl: string }
  | { mode: "external"; profileSlug: string; profile: AgentProfile };

export async function resolveAgentTransport(
  env: Record<string, string | undefined>,
  profileSlug: string | undefined,
  store: ProfileStore,
): Promise<AgentTransportTarget> {
  if (profileSlug === undefined)
    return {
      mode: "daemon",
      socketPath: env.COFORGE_DAEMON_SOCKET ?? "",
      context: env.COFORGE_AGENT_CONTEXT ?? "",
      proxyUrl: env.COFORGE_AGENT_PROXY_URL ?? "",
    };
  const profile = await store.readProfile(profileSlug);
  if (!profile) throw profileNotLoggedInError(profileSlug);
  if (env.COFORGE_AGENT_PROXY_URL || env.COFORGE_AGENT_CONTEXT)
    process.stderr.write(
      `Using external profile "${profileSlug}" (ignoring daemon proxy environment).\n`,
    );
  return { mode: "external", profileSlug, profile };
}

export function proxyConnectionOf(target: AgentTransportTarget): {
  socketPath: string;
  context: string;
  proxyUrl: string;
} {
  return target.mode === "daemon"
    ? target
    : { socketPath: "", context: target.profile.apiKey, proxyUrl: target.profile.serverUrl };
}
