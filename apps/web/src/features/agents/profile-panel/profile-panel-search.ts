import { z } from "zod";
import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";

/**
 * The profile panel's URL state, shared by the Members directory and every conversation page:
 * `profile=agent:<uuid>` opens the panel on a given Agent, `agentTab` selects its tab, and
 * `profile=user:<uuid>` opens a person's panel in the same slot. Kept in its own module so the search-param shape, its zod validators and the tiny encode/decode helpers have
 * one home the routes and the panel both import, instead of separate copies of the same regex.
 */

const AGENT_PROFILE_PREFIX = "agent:";
const UUID_SOURCE = UUID_LIKE_SOURCE;
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const PERSON_PROFILE_PREFIX = "user:";
const PROFILE_PATTERN = new RegExp(
  `^(?:${AGENT_PROFILE_PREFIX}|${PERSON_PROFILE_PREFIX})${UUID_SOURCE}$`,
  "i",
);

export const AGENT_PROFILE_TABS = ["profile", "activity", "reminders", "workspace"] as const;
export type AgentProfileTab = (typeof AGENT_PROFILE_TABS)[number];

/** Validates the raw `profile` search param: `undefined`, `agent:<uuid>` or `user:<uuid>`.
 * Malformed values fall back to `undefined` (closed) rather than erroring, matching the routes'
 * existing `.catch()` convention for `threadRootId`/`message`. */
export const profileParamSchema = z.string().regex(PROFILE_PATTERN).optional().catch(undefined);

export const agentProfileTabParamSchema = z.enum(AGENT_PROFILE_TABS).optional().catch(undefined);

/** The `profile` search param value that opens the panel on one Agent. */
export function formatAgentProfileParam(agentId: string): string {
  return `${AGENT_PROFILE_PREFIX}${agentId}`;
}

/** The `profile` search param value that opens the panel on one person. */
export function formatPersonProfileParam(userId: string): string {
  return `${PERSON_PROFILE_PREFIX}${userId}`;
}

/** The person's id encoded in a `profile` search param, or `undefined` when it names no person. */
export function personIdFromProfileParam(profile: string | undefined): string | undefined {
  return idFromProfileParam(profile, PERSON_PROFILE_PREFIX);
}

export function agentProfileSearchWithoutThread<T extends { threadRootId?: string }>(
  previous: T,
): Omit<T, "threadRootId"> {
  const { threadRootId: _threadRootId, ...rest } = previous;
  return rest;
}

/** The Agent id encoded in a `profile` search param, or `undefined` when the panel is closed or
 * the param does not name an Agent (already validated by `profileParamSchema`, but callers
 * that read raw search state — e.g. before validation — can use this defensively too). */
export function agentIdFromProfileParam(profile: string | undefined): string | undefined {
  return idFromProfileParam(profile, AGENT_PROFILE_PREFIX);
}

function idFromProfileParam(profile: string | undefined, prefix: string): string | undefined {
  if (!profile || !profile.startsWith(prefix)) return undefined;
  const id = profile.slice(prefix.length);
  return UUID_PATTERN.test(id) ? id : undefined;
}

/** The panel offers Profile, Reminders, Activity and Workspace. Reminders and Activity are
 * manager/owner-only (brief §Permissions); Workspace has its own, narrower gate — the Agent's
 * owner only, independent of `canSeeManagerTabs` (a manager who does not own the Agent must not
 * see Workspace). Returned in default order. */
export function visibleAgentProfileTabs(
  canSeeManagerTabs: boolean,
  canSeeWorkspace: boolean,
): AgentProfileTab[] {
  return AGENT_PROFILE_TABS.filter((tab) =>
    tab === "profile" ? true : tab === "workspace" ? canSeeWorkspace : canSeeManagerTabs,
  );
}

/** The tab the panel shows: the requested one when the viewer can see it, otherwise the first of
 * `tabs` — the viewer's visible tabs in their saved order. */
export function resolveAgentProfileTab(
  requested: AgentProfileTab | undefined,
  tabs: readonly AgentProfileTab[],
): AgentProfileTab {
  return requested && tabs.includes(requested) ? requested : (tabs[0] ?? "profile");
}
