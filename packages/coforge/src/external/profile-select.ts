import { CliError } from "../cli-error";
import { isValidProfileSlug, type ProfileStore } from "./profile-store";

export type ProfileSelection = { slug?: string; args: string[] };

function profileConflict(flag: string, env: string): CliError {
  return new CliError({
    code: "PROFILE_CONFLICT",
    message: `--profile ${flag} conflicts with COFORGE_PROFILE=${env}.`,
    retryable: false,
    suggestedNextAction: "Pass only one of them, or make them name the same profile.",
  });
}

export function selectProfile(
  args: readonly string[],
  env: Record<string, string | undefined>,
): ProfileSelection {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const rest = separator === -1 ? [] : args.slice(separator);
  const kept: string[] = [];
  let flag: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg === "--profile" ? own[++index] : arg.slice("--profile=".length);
      if (!value)
        throw new CliError({
          code: "INVALID_ARG",
          message: "--profile needs a profile name.",
          retryable: false,
        });
      if (flag !== undefined && flag !== value) throw profileConflict(flag, value);
      flag = value;
    } else kept.push(arg);
  }
  const fromEnv = env.COFORGE_PROFILE?.trim() || undefined;
  if (flag !== undefined && fromEnv !== undefined && flag !== fromEnv)
    throw profileConflict(flag, fromEnv);
  const slug = flag ?? fromEnv;
  if (slug !== undefined && !isValidProfileSlug(slug))
    throw new CliError({
      code: "PROFILE_INVALID",
      message: `"${slug}" is not a valid profile name; use letters, digits, ".", "_" and "-".`,
      retryable: false,
    });
  return { ...(slug === undefined ? {} : { slug }), args: [...kept, ...rest] };
}

export async function selectedOrOnlyProfile(
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
