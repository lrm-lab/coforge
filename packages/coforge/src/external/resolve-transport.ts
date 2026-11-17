import { CliError } from "../cli-error";
import type { AgentProfile, ProfileStore } from "./profile-store";

/** Where an Agent API call goes and who it speaks as: the daemon's loopback proxy with the
 * launch's context token, or the server itself with an external Agent's key. */
export type AgentTransportTarget =
  | { mode: "daemon"; socketPath: string; context: string; proxyUrl: string }
  | {
      mode: "external";
      socketPath: string;
      context: string;
      proxyUrl: string;
      profileSlug: string;
      profile: AgentProfile;
    };

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
  if (!profile)
    throw new CliError({
      code: "PROFILE_NOT_LOGGED_IN",
      message: `Profile "${profileSlug}" has no credential.`,
      retryable: false,
      suggestedNextAction: "Run `coforge agent login --server <url> --agent <id-or-name>` first.",
    });
  if (env.COFORGE_AGENT_PROXY_URL || env.COFORGE_AGENT_CONTEXT)
    process.stderr.write(
      `Using external profile "${profileSlug}" (ignoring daemon proxy environment).\n`,
    );
  return {
    mode: "external",
    socketPath: "",
    context: profile.apiKey,
    proxyUrl: profile.serverUrl,
    profileSlug,
    profile,
  };
}
