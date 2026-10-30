import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { AgentChannelManagementError } from "./agent-channel-management-error.server";

// The Agent CLI's channel targets, new channel names and member handles, read for
// `AgentChannelManagement`.

const CHANNEL_TARGET = /^#[a-z0-9][a-z0-9_-]{0,31}$/;
export const USER_TARGET = /^@[a-z0-9][a-z0-9_-]{0,31}$/;
const MEMBER_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,31}$/;

export type AgentChannelMemberInput = { user?: string; agent?: string };

/** A member handle that names no one this operation can reach (404). */
export function memberNotFound(handle: string) {
  return new AgentChannelManagementError(404, `member not found: @${handle}`);
}

/** A `#channel` target's channel name (400 if malformed). */
export function parseChannelTarget(target: string): string {
  if (!CHANNEL_TARGET.test(target))
    throw new AgentChannelManagementError(400, "target must be a #channel");
  return target.slice(1);
}

/** A new channel's name, with or without its `#` (400 if not a valid name). */
export function normalizeChannelName(rawName: string): string {
  const name = rawName.startsWith("#") ? rawName.slice(1) : rawName;
  if (!CHANNEL_NAME_PATTERN.test(name))
    throw new AgentChannelManagementError(400, "invalid channel name");
  return name;
}

/** Exactly one of `--user` or `--agent`, as an @handle (400 otherwise). */
export function parseMemberInput(input: AgentChannelMemberInput): {
  kind: "user" | "agent";
  handle: string;
} {
  if ((input.user === undefined) === (input.agent === undefined))
    throw new AgentChannelManagementError(400, "exactly one of --user or --agent is required");
  const kind: "user" | "agent" = input.user !== undefined ? "user" : "agent";
  const raw = (input.user ?? input.agent)!;
  if (!MEMBER_HANDLE.test(raw))
    throw new AgentChannelManagementError(400, "member handle must be an @handle");
  return { kind, handle: raw.slice(1) };
}
