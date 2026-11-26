import { AGENT_PROFILE_DESCRIPTION_MAX_LENGTH } from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { parseCliFlags } from "./cli-flags";

export type ProfileUpdateInvocation = {
  command: "profile-update";
  displayName?: string;
  description?: string;
  json?: boolean;
};

const DISPLAY_NAME_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = AGENT_PROFILE_DESCRIPTION_MAX_LENGTH;

const PROFILE_UPDATE_USAGE =
  'Usage: coforge profile update [--display-name "<text>"] [--description "<text>"] [--json]';

export function parseProfileUpdateArgs(args: readonly string[]): ProfileUpdateInvocation {
  const { values } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      "display-name": { type: "string" },
      description: { type: "string" },
    },
    onError() {
      throw new Error(PROFILE_UPDATE_USAGE);
    },
  });
  const displayName = values["display-name"];
  const description = values.description;
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
    ...(values.json ? { json: true } : {}),
  };
}
