import { CliError } from "../cli-error";
import { isValidProfileSlug } from "./profile-store";

export type ProfileSelection = { slug?: string; args: string[] };

function profileConflict(flag: string, env: string): CliError {
  return new CliError({
    code: "PROFILE_CONFLICT",
    message: `--profile ${flag} conflicts with COFORGE_PROFILE=${env}.`,
    retryable: false,
    suggestedNextAction: "Pass only one of them, or make them name the same profile.",
  });
}

/**
 * Takes the global `--profile <slug>` flag out of `args` (never past a `--`, which belongs to the
 * program an `app token --exec` runs) and settles it against `COFORGE_PROFILE`.
 */
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
