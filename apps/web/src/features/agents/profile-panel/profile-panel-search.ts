import { z } from "zod";
import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";

const AGENT_PROFILE_PREFIX = "agent:";
const UUID_SOURCE = UUID_LIKE_SOURCE;
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const PERSON_PROFILE_PREFIX = "user:";
const PROFILE_PATTERN = new RegExp(
  `^(?:${AGENT_PROFILE_PREFIX}|${PERSON_PROFILE_PREFIX})${UUID_SOURCE}$`,
  "i",
);

export const AGENT_PROFILE_TABS = [
  "profile",
  "activity",
  "chat",
  "reminders",
  "workspace",
  "apps",
  "usage",
] as const;
export type AgentProfileTab = (typeof AGENT_PROFILE_TABS)[number];

export const profileParamSchema = z.string().regex(PROFILE_PATTERN).optional().catch(undefined);

export const agentProfileTabParamSchema = z.enum(AGENT_PROFILE_TABS).optional().catch(undefined);

export function formatAgentProfileParam(agentId: string): string {
  return `${AGENT_PROFILE_PREFIX}${agentId}`;
}

export function formatPersonProfileParam(userId: string): string {
  return `${PERSON_PROFILE_PREFIX}${userId}`;
}

export function personIdFromProfileParam(profile: string | undefined): string | undefined {
  return idFromProfileParam(profile, PERSON_PROFILE_PREFIX);
}

export function agentProfileSearchBase<
  T extends { details?: unknown; doc?: string; docFull?: boolean },
>(previous: T): Omit<T, "details" | "doc" | "docFull"> {
  const { details: _details, doc: _doc, docFull: _docFull, ...rest } = previous;
  return rest;
}

export function agentIdFromProfileParam(profile: string | undefined): string | undefined {
  return idFromProfileParam(profile, AGENT_PROFILE_PREFIX);
}

function idFromProfileParam(profile: string | undefined, prefix: string): string | undefined {
  if (!profile || !profile.startsWith(prefix)) return undefined;
  const id = profile.slice(prefix.length);
  return UUID_PATTERN.test(id) ? id : undefined;
}

export function visibleAgentProfileTabs(
  canSeeManagerTabs: boolean,
  canSeeApps: boolean,
  canSeeChat: boolean,
  canSeeUsage = canSeeManagerTabs,
): AgentProfileTab[] {
  const visible = {
    profile: true,
    activity: canSeeManagerTabs,
    chat: canSeeChat,
    reminders: canSeeManagerTabs,
    workspace: canSeeManagerTabs,
    apps: canSeeApps,
    usage: canSeeUsage,
  };
  return AGENT_PROFILE_TABS.filter((tab) => visible[tab]);
}

export function resolveAgentProfileTab(
  requested: AgentProfileTab | undefined,
  tabs: readonly AgentProfileTab[],
): AgentProfileTab {
  return requested && tabs.includes(requested) ? requested : (tabs[0] ?? "profile");
}
