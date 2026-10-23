import { AppError } from "#src/lib/app-error";
import { isAgentInboundScope } from "#src/features/apps/app-agent-events";
import { APP_AGENT_INBOUND_SCOPES } from "#src/features/apps/app-registration";
import { canManageAgentAppAccess } from "#src/server/app-agent-access/access-rules.server";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";

/** An INVALID_INPUT (`app-scope-not-allowed`) for an Agent inbound scope the app did not declare,
 * or that is not one. The HTTP side answers it `invalid_scope`. */
export class InboundScopeNotAllowedError extends AppError {
  constructor(readonly scopes: readonly string[]) {
    super("INVALID_INPUT", { errorId: "app-scope-not-allowed" });
  }
}

/** A request lives a day: after that a pending one cannot be approved and an approved one cannot be
 * exchanged, and the app asks again. Raft documents no request expiry; this is CoForge's. */
export const INBOUND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export const inboundRequestExpired = (createdAt: Date, now: Date) =>
  createdAt.getTime() + INBOUND_REQUEST_TTL_MS <= now.getTime();

/** The Agent inbound scopes of `scopes`, once each, in canonical order. */
export const inboundScopesOf = (scopes: readonly string[]) =>
  APP_AGENT_INBOUND_SCOPES.filter((scope) => scopes.includes(scope));

/** Whether every one of `requested` is among `held`. */
export const coversScopes = (held: readonly string[], requested: readonly string[]) =>
  requested.every((scope) => held.includes(scope));

/** An app's grant for an Agent, active or revoked. */
export type InboundGrantFacts = { scopes: readonly string[]; revoked: boolean; source: string };

/**
 * The one authority on what an app may send to an Agent now, used when it asks, when its request
 * is exchanged and each time its token is used. `working` says the grant exists, is active and
 * works for this Agent: the installation includes the Agent, or a person approved the grant (a
 * person's decision works for any Agent, as an Agent's app grant does). `scopes` are then what it
 * holds that the app still declares, so narrowing the declaration takes effect at once.
 */
export function effectiveInboundAccess(facts: {
  declared: readonly string[];
  grant: InboundGrantFacts | undefined;
  inScope: boolean;
}): { working: boolean; scopes: string[] } {
  const { grant } = facts;
  if (!grant || grant.revoked || !(facts.inScope || grant.source === "approval"))
    return { working: false, scopes: [] };
  return {
    working: true,
    scopes: inboundScopesOf(grant.scopes).filter((scope) => facts.declared.includes(scope)),
  };
}

/** What is known when an app asks to send to one Agent: the facts `decideInboundAccess` judges. */
export type InboundAccessFacts = {
  /** The scopes the app declares in its registration. */
  declared: readonly string[];
  requested: readonly string[];
  /** The app's grant for the Agent, active or revoked; `undefined` when it never had one. */
  grant: InboundGrantFacts | undefined;
  /** Whether the installation includes the Agent (`agentInScope`). A grant works for an Agent
   * outside it only when a person approved that grant. */
  inScope: boolean;
  /** Whether the automatic rule holds (`autoApprovalApplies`). */
  automatic: boolean;
  /** The app's request for the Agent that waits for a person. */
  pendingRequest: { id: string; scopes: readonly string[] } | undefined;
};

export type InboundAccessDecision =
  /** The active grant covers the request (`created: false`), or the automatic rule gives one now
   * (`created: true`): the request is approved with `scopes`, which `grant` keeps. */
  | { kind: "approved"; scopes: string[]; created: boolean }
  /** A person must approve `scopes`; `pendingRequestId` names the request already waiting. */
  | { kind: "pending"; scopes: string[]; pendingRequestId?: string };

/**
 * The rule for an app's request to send to an Agent. A scope the app did not declare is refused. An
 * active grant covering the request approves it. With no grant, or a grant that lacks scopes, the
 * automatic rule approves it (and widens the grant); once a person revoked the grant, only a
 * person's approval gives one again, whatever the rule says.
 */
export function decideInboundAccess(facts: InboundAccessFacts): InboundAccessDecision {
  const requested = inboundScopesOf(facts.requested);
  const refused = facts.requested.filter(
    (scope) => !isAgentInboundScope(scope) || !facts.declared.includes(scope),
  );
  if (requested.length === 0 || refused.length > 0) throw new InboundScopeNotAllowedError(refused);
  const { grant, pendingRequest } = facts;
  const held = effectiveInboundAccess(facts);
  if (held.working && coversScopes(held.scopes, requested))
    return { kind: "approved", scopes: requested, created: false };
  if (facts.automatic && !grant?.revoked)
    return {
      kind: "approved",
      scopes: inboundScopesOf([...(grant?.scopes ?? []), ...requested]),
      created: true,
    };
  const scopes = inboundScopesOf([...(pendingRequest?.scopes ?? []), ...requested]);
  return {
    kind: "pending",
    scopes,
    ...(pendingRequest ? { pendingRequestId: pendingRequest.id } : {}),
  };
}

/**
 * Whether an app's request to send to an Agent is approved without a person. An app registered in
 * the Agent's own Workspace needs its creator to be a current member who may manage the Agent's app
 * access: a Workspace owner or admin, or the Agent's human creator. An app installed from another
 * Workspace follows the installation's authority alone. Either way the installation must include
 * the Agent (`agentInScope`).
 */
export function autoApprovalApplies(facts: {
  /** The app was registered in the Agent's Workspace. */
  local: boolean;
  /** The installation lets the Agent use the app. */
  inScope: boolean;
  /** The app's creator, with their role in the Agent's Workspace (`undefined`: not a member). */
  creator: { userId: string; role: WorkspaceMemberRole | undefined } | undefined;
  agent: { ownerId: string };
}): boolean {
  if (!facts.inScope) return false;
  if (!facts.local) return true;
  return facts.creator !== undefined && canManageAgentAppAccess(facts.creator, facts.agent);
}
