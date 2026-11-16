import { CliError } from "../cli-error";
import { probeContext } from "./agent-context";
import type { FetchLike } from "./device-client";
import type { ProfileStore } from "./profile-store";
import { revokeSelf } from "./self-revoke";

export type ProfileCommandDeps = { store: ProfileStore; fetch: FetchLike };

export type StatusState = "usable" | "revoked" | "mismatch" | "missing" | "unverified";

/** The profile a `status` or `logout` acts on: the selected one, else the only one on disk. */
async function targetProfile(
  store: ProfileStore,
  selected: string | undefined,
): Promise<string | undefined> {
  if (selected !== undefined) return selected;
  const all = await store.listProfiles();
  if (all.length > 1)
    throw new CliError({
      code: "PROFILE_AMBIGUOUS",
      message: `Several profiles exist (${all.join(", ")}).`,
      retryable: false,
      suggestedNextAction: "Pass --profile <slug> or set COFORGE_PROFILE.",
    });
  return all[0];
}

const STATUS_DETAIL: Record<StatusState, string> = {
  usable: "The server accepts this profile's key.",
  revoked: "The server rejected this profile's key; run `coforge agent login` again.",
  mismatch: "The key now belongs to a different Agent than the profile records.",
  missing: "No credential is saved for this profile.",
  unverified: "The server could not be reached or did not answer; try again.",
};

export async function runAgentStatus(
  args: readonly string[],
  selected: string | undefined,
  deps: ProfileCommandDeps,
): Promise<{ output: string; exitCode: number }> {
  if (args.length > 0)
    throw new CliError({
      code: "INVALID_ARG",
      message: "Usage: coforge agent status [--profile <slug>]",
      retryable: false,
    });
  const { store } = deps;
  const slug = await targetProfile(store, selected);
  const profile = slug === undefined ? undefined : await store.readProfile(slug);
  let state: StatusState = "missing";
  if (profile) {
    const probe = await probeContext(profile, deps.fetch);
    state =
      probe.state === "ok"
        ? probe.context.agent.id === profile.agentId
          ? "usable"
          : "mismatch"
        : probe.state === "unauthorized"
          ? "revoked"
          : "unverified";
  }
  const lines = [`state: ${state}`];
  if (slug !== undefined) lines.push(`Profile: ${slug}`);
  if (profile)
    lines.push(
      `Agent: @${profile.agentName} in ${profile.workspaceSlug}`,
      `Server: ${profile.serverUrl}`,
    );
  lines.push(STATUS_DETAIL[state]);
  return { output: lines.join("\n"), exitCode: state === "usable" ? 0 : 1 };
}

export async function runAgentLogout(
  args: readonly string[],
  selected: string | undefined,
  deps: ProfileCommandDeps,
): Promise<string> {
  if (args.length > 0)
    throw new CliError({
      code: "INVALID_ARG",
      message: "Usage: coforge agent logout [--profile <slug>]",
      retryable: false,
    });
  const { store } = deps;
  const slug = await targetProfile(store, selected);
  if (slug === undefined) return "state: not_logged_in";
  let profile: Awaited<ReturnType<typeof store.readProfile>>;
  try {
    profile = await store.readProfile(slug);
  } catch (error) {
    if (error instanceof CliError && error.code === "PROFILE_CORRUPT") {
      await store.removeProfile(slug);
      await store.removeCursor(slug);
      return `state: logged_out\nProfile: ${slug}\nKey: corrupt local credential removed.`;
    }
    throw error;
  }
  if (!profile) return "state: not_logged_in";
  const outcome = await revokeSelf(deps.fetch, profile.serverUrl, profile.apiKey);
  if (outcome.state === "failed")
    throw new CliError({
      code: "CREDENTIAL_REVOKE_FAILED",
      message: `The server could not revoke this key (${outcome.detail}); the saved credential was kept.`,
      retryable: true,
      suggestedNextAction: "Try `coforge agent logout` again when the server is reachable.",
    });
  await store.removeProfile(slug);
  await store.removeCursor(slug);
  return `state: logged_out\nProfile: ${slug}\nKey: ${outcome.state === "revoked" ? "revoked" : "already revoked"}.`;
}
