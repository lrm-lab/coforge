export type ProfileUpdateInvocation = {
  command: "profile-update";
  displayName?: string;
  description?: string;
  json?: boolean;
};

const PROFILE_UPDATE_USAGE =
  'Usage: coforge profile update [--display-name "<text>"] [--description "<text>"] [--json]';

export function parseProfileUpdateArgs(args: readonly string[]): ProfileUpdateInvocation {
  let displayName: string | undefined;
  let description: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--display-name" || arg === "--description") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(PROFILE_UPDATE_USAGE);
      if (arg === "--display-name") displayName = value;
      else description = value;
      index += 1;
      continue;
    }
    throw new Error(PROFILE_UPDATE_USAGE);
  }
  if (displayName === undefined && description === undefined) throw new Error(PROFILE_UPDATE_USAGE);
  return {
    command: "profile-update",
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(json ? { json: true } : {}),
  };
}
