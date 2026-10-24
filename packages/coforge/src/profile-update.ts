export type ProfileUpdateInvocation = {
  command: "profile-update";
  displayName?: string;
  description?: string;
  json?: boolean;
};

// The server's own limits (`AGENT_DISPLAY_NAME_MAX_LENGTH`, `AGENT_PROFILE_DESCRIPTION_MAX_LENGTH`),
// checked here so a too-long value fails before any request.
const DISPLAY_NAME_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 500;

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
  if (displayName === undefined && description === undefined)
    throw new Error(
      `Provide at least one of --display-name or --description\n${PROFILE_UPDATE_USAGE}`,
    );
  if (displayName !== undefined) {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) throw new Error("--display-name must not be empty");
    if (trimmed.length > DISPLAY_NAME_MAX_LENGTH)
      throw new Error(`--display-name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  if (description !== undefined && description.trim().length > DESCRIPTION_MAX_LENGTH)
    throw new Error(`--description must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
  return {
    command: "profile-update",
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(json ? { json: true } : {}),
  };
}
