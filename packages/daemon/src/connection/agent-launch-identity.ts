import {
  normalizeAgentLaunchApps,
  AGENT_PROFILE_DESCRIPTION_MAX_LENGTH,
  type AgentLaunchApp,
} from "@lrm/coforge-sdk/internal/agent-launch-apps";
import type { AgentLaunchIdentity } from "#src/code-agent/agent-instructions";

const IDENTITY_NAME_MAX_LENGTH = 80;
const IDENTITY_DESCRIPTION_MAX_LENGTH = AGENT_PROFILE_DESCRIPTION_MAX_LENGTH;
const IDENTITY_OTHER_MAX_LENGTH = 200;

/** A trimmed, length-capped wire string, or `undefined` for anything else (wrong type, empty
 * after trimming, or over the cap) — never a thrown error, so one bad field never invalidates
 * the rest of `identity`. */
function parseIdentityString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function parseIdentityRuntimeContext(
  value: unknown,
): AgentLaunchIdentity["runtimeContext"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const runtimeContext = {
    workspaceId: parseIdentityString(record.workspaceId, IDENTITY_OTHER_MAX_LENGTH),
    workspaceSlug: parseIdentityString(record.workspaceSlug, IDENTITY_OTHER_MAX_LENGTH),
    workspaceName: parseIdentityString(record.workspaceName, IDENTITY_OTHER_MAX_LENGTH),
    computerId: parseIdentityString(record.computerId, IDENTITY_OTHER_MAX_LENGTH),
    computerName: parseIdentityString(record.computerName, IDENTITY_OTHER_MAX_LENGTH),
    computerHostname: parseIdentityString(record.computerHostname, IDENTITY_OTHER_MAX_LENGTH),
    computerOs: parseIdentityString(record.computerOs, IDENTITY_OTHER_MAX_LENGTH),
    computerVersion: parseIdentityString(record.computerVersion, IDENTITY_OTHER_MAX_LENGTH),
  };
  const present = Object.fromEntries(
    Object.entries(runtimeContext).filter(([, entry]) => entry !== undefined),
  );
  return Object.keys(present).length > 0
    ? (present as AgentLaunchIdentity["runtimeContext"])
    : undefined;
}

/** The Workspace's installed apps, normalised again here whatever the server did: the standing
 * prompt renders them as they are. A server older than the field sends none. */
function parseIdentityApps(value: unknown): AgentLaunchApp[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const apps = normalizeAgentLaunchApps(value);
  return apps.length > 0 ? apps : undefined;
}

/** Only an explicit `taskConversations: true` turns the feature on; anything else is off. */
function parseIdentityFeatures(value: unknown): AgentLaunchIdentity["features"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).taskConversations === true
    ? { taskConversations: true }
    : undefined;
}

/**
 * Decode optional launch identity fields defensively for older/newer Web compatibility.
 * Invalid shapes drop the identity or sub-field instead of failing launch; only identity-derived
 * standing instructions degrade. Unlike runtime provider config/API keys, this parser never throws.
 */
export function parseAgentLaunchIdentity(value: unknown): AgentLaunchIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity: AgentLaunchIdentity = {
    ...(record.systemKind === "workspace-assistant"
      ? { systemKind: "workspace-assistant" as const }
      : {}),
    name: parseIdentityString(record.name, IDENTITY_NAME_MAX_LENGTH),
    displayName: parseIdentityString(record.displayName, IDENTITY_NAME_MAX_LENGTH),
    description: parseIdentityString(record.description, IDENTITY_DESCRIPTION_MAX_LENGTH),
    runtimeContext: parseIdentityRuntimeContext(record.runtimeContext),
    apps: parseIdentityApps(record.apps),
    features: parseIdentityFeatures(record.features),
  };
  const present = Object.fromEntries(
    Object.entries(identity).filter(([, entry]) => entry !== undefined),
  );
  return Object.keys(present).length > 0 ? (present as AgentLaunchIdentity) : undefined;
}
