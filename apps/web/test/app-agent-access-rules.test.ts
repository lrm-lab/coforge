import { describe, expect, test } from "bun:test";

import { isAppErrorCode } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";
import {
  canManageAgentAppAccess,
  decideAgentAccess,
} from "#src/server/app-agent-access/access-rules.server";

/**
 * When an Agent may use an app installed in its Workspace, and who may change that for an Agent,
 * without a database. The store that applies the decision is `app-agent-access.integration.test.ts`.
 */
const ALL_SCOPES = ["openid", "profile", "identity", "email"];
const FIXED = ["openid", "profile", "identity"];

const facts = (overrides: Partial<Parameters<typeof decideAgentAccess>[0]> = {}) => ({
  installed: true,
  allowedScopes: ALL_SCOPES,
  requestedScopes: [],
  grant: undefined,
  pendingRequest: undefined,
  ...overrides,
});

describe("decideAgentAccess", () => {
  test("an app not installed in the Agent's Workspace is not usable, whatever its grant", () => {
    expect(decideAgentAccess(facts({ installed: false }))).toEqual({ kind: "not_installed" });
    expect(
      decideAgentAccess(facts({ installed: false, grant: { scopes: FIXED, revoked: false } })),
    ).toEqual({ kind: "not_installed" });
  });

  test("the first use of an installed app grants it automatically, with the fixed scopes", () => {
    expect(decideAgentAccess(facts())).toEqual({ kind: "grant_automatically", scopes: FIXED });
    expect(decideAgentAccess(facts({ requestedScopes: ["email"] }))).toEqual({
      kind: "grant_automatically",
      scopes: ALL_SCOPES,
    });
  });

  test("an active grant that covers the request is used as it is", () => {
    expect(
      decideAgentAccess(
        facts({ requestedScopes: ["openid"], grant: { scopes: ALL_SCOPES, revoked: false } }),
      ),
    ).toEqual({ kind: "granted", scopes: ALL_SCOPES });
  });

  test("an active grant is used only with the scopes the app still allows", () => {
    expect(
      decideAgentAccess(
        facts({ allowedScopes: FIXED, grant: { scopes: ALL_SCOPES, revoked: false } }),
      ),
    ).toEqual({ kind: "granted", scopes: FIXED });
  });

  test("after a revoke the Agent needs an approval, and a pending request is reused as it is", () => {
    const revoked = { scopes: ALL_SCOPES, revoked: true };
    expect(decideAgentAccess(facts({ grant: revoked }))).toEqual({
      kind: "needs_approval",
      scopes: FIXED,
    });
    expect(
      decideAgentAccess(
        facts({ grant: revoked, pendingRequest: { id: "request-1", scopes: ALL_SCOPES } }),
      ),
    ).toEqual({ kind: "needs_approval", scopes: ALL_SCOPES, pendingRequestId: "request-1" });
  });

  test("a scope the active grant lacks needs an approval for the grant's scopes and the new one", () => {
    expect(
      decideAgentAccess(
        facts({ requestedScopes: ["email"], grant: { scopes: FIXED, revoked: false } }),
      ),
    ).toEqual({ kind: "needs_approval", scopes: ALL_SCOPES });
  });

  test("a scope the app may not ask for is refused", () => {
    let error: unknown;
    try {
      decideAgentAccess(facts({ allowedScopes: FIXED, requestedScopes: ["email"] }));
    } catch (caught) {
      error = caught;
    }
    expect(isAppErrorCode(error, "INVALID_INPUT")).toBe(true);
  });
});

describe("canManageAgentAppAccess", () => {
  const agent = { ownerId: "creator" };

  test("Workspace owners and admins manage any Agent's app access", () => {
    expect(canManageAgentAppAccess({ userId: "someone", role: "owner" }, agent)).toBe(true);
    expect(canManageAgentAppAccess({ userId: "someone", role: "admin" }, agent)).toBe(true);
  });

  test("a member manages only the Agents they created", () => {
    expect(canManageAgentAppAccess({ userId: "creator", role: "member" }, agent)).toBe(true);
    expect(canManageAgentAppAccess({ userId: "someone", role: "member" }, agent)).toBe(false);
  });

  test("a creator who is no longer a member, or whose role is unknown, manages nothing", () => {
    expect(canManageAgentAppAccess({ userId: "creator", role: undefined }, agent)).toBe(false);
    // A stored role outside the known three fails closed, even for the Agent's creator.
    const unknown = "guest" as WorkspaceMemberRole;
    expect(canManageAgentAppAccess({ userId: "creator", role: unknown }, agent)).toBe(false);
  });
});
