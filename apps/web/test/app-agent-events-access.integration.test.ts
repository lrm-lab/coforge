import { expect, test } from "bun:test";

import { removeAppInstallations } from "#src/server/db/repositories/app-installation.repositories.server";
import { agentInboundResource } from "#src/server/authorization-server/agent-inbound-tokens.server";
import { ISSUER, basic } from "./oidc-token-fixture";
import { BOTH, EVENT, ON_SLUG, db, fixture, useAgentEventsFlag } from "./app-agent-events-fixture";

/** Agent inbound access: scope declaration, request approval, revocation and the flag. */
useAgentEventsFlag();

test.skipIf(!db)(
  "a scope the app did not declare, or that is not an Agent inbound scope, is invalid_scope",
  async () => {
    const f = await fixture(db!, ["openid", "profile", "identity", "agent:event:write"]);
    try {
      const undeclared = await f.ask(f.scout.id, ["agent:notification:write"]);
      expect(undeclared.response.status).toBe(400);
      expect(undeclared.body.error).toBe("invalid_scope");
      const login = await f.ask(f.scout.id, ["openid"]);
      expect(login.body.error).toBe("invalid_scope");
      const none = await f.ask(f.scout.id, []);
      expect(none.body.error).toBe("invalid_request");
      expect((await f.ask(f.scout.id, ["agent:event:write"])).body.status).toBe("approved");
      // The request names a Workspace and an Agent that exist, or finds nothing.
      expect(
        (await f.ask(f.scout.id, ["agent:event:write"], "no-such-workspace")).response.status,
      ).toBe(404);
      expect((await f.ask(crypto.randomUUID())).response.status).toBe(404);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a request is approved at once for the app owner's Agent, by name too, and waits otherwise",
  async () => {
    const f = await fixture(db!);
    try {
      const named = await f.endpoints.agentInbound.request(
        f.post(
          "/api/app-agent-requests",
          {
            workspace_slug: f.workspace.slug,
            agent_name: f.scout.name,
            scopes: ["agent:event:write"],
          },
          { authorization: basic(f.key, "x") },
        ),
      );
      // A wrong secret is invalid_client.
      expect(named.status).toBe(401);

      // The creator is the Workspace owner, so the rule approves and records an automatic grant.
      const approved = await f.ask(f.scout.id);
      expect(approved.response.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: "approved",
        scopes: ["agent:event:write"],
        agent: { id: f.scout.id, workspace_id: f.workspace.id, workspace_slug: f.workspace.slug },
        resource: agentInboundResource(ISSUER, f.workspace.id),
      });
      expect(
        await db!.appAgentInboundGrant.findUniqueOrThrow({
          where: { appId_agentId: { appId: f.app.id, agentId: f.scout.id } },
        }),
      ).toMatchObject({ source: "automatic", scopes: ["agent:event:write"], revokedAt: null });

      // A member who created the app, for an Agent the owner created, waits for a person.
      await db!.app.update({ where: { id: f.app.id }, data: { createdByUserId: f.member.id } });
      const waiting = await f.ask(f.other.id);
      expect(waiting.body.status).toBe("pending");
      // Asking again, wider, widens the one waiting request.
      const again = await f.ask(f.other.id, ["agent:event:write", "agent:notification:write"]);
      expect(again.body.request_id).toBe(waiting.body.request_id);
      expect(again.body.scopes).toEqual(["agent:event:write", "agent:notification:write"]);
      expect(await db!.appAgentInboundRequest.count({ where: { agentId: f.other.id } })).toBe(1);

      // The exchange waits for the decision.
      const early = await f.exchange(waiting.body.request_id);
      expect(early.body.error).toBe("authorization_pending");
      // A member who is neither an admin nor the Agent's creator may not decide it.
      await expect(
        f.inbound.approve(
          { workspaceId: f.workspace.id, userId: f.member.id },
          { agentId: f.other.id, requestId: waiting.body.request_id },
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      // The Workspace owner approves it; the grant carries the scopes and the exchange works.
      await f.inbound.approve(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        { agentId: f.other.id, requestId: waiting.body.request_id },
      );
      expect((await f.statusOf(waiting.body.request_id)).body.status).toBe("approved");
      // Another app's credentials see no such request.
      expect(
        (await f.statusOf(waiting.body.request_id, basic(f.key, "wrong"))).response.status,
      ).toBe(401);
      const exchanged = await f.exchange(waiting.body.request_id);
      expect(exchanged.response.status).toBe(200);
      expect(exchanged.body).toMatchObject({
        token_type: "Bearer",
        scope: "agent:event:write agent:notification:write",
        resource: agentInboundResource(ISSUER, f.workspace.id),
      });

      // A denied request is access_denied.
      await db!.appAgentInboundGrant.deleteMany({ where: { appId: f.app.id } });
      await db!.appAgentInboundRequest.deleteMany({ where: { agentId: f.other.id } });
      const denied = await f.ask(f.other.id);
      await f.inbound.deny(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        { agentId: f.other.id, requestId: denied.body.request_id },
      );
      expect((await f.exchange(denied.body.request_id)).body.error).toBe("access_denied");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "the Agent's creator is enough for an app a member created; an installed app follows its installation's Agent scope",
  async () => {
    const f = await fixture(db!);
    try {
      await db!.app.update({ where: { id: f.app.id }, data: { createdByUserId: f.member.id } });
      const theirs = await db!.agent.create({
        data: {
          workspaceId: f.workspace.id,
          name: `mine-${f.suffix}`,
          displayName: "mine",
          ownerId: f.member.id,
          runtimeConfig: {},
        },
      });
      // The creator is the app creator's own Agent's creator: approved without a person.
      expect((await f.ask(theirs.id)).body.status).toBe("approved");

      // An app registered in another Workspace follows the installation's authority.
      const stranger = await db!.workspace.create({
        data: {
          slug: `${ON_SLUG}-x${f.suffix}`,
          name: "Other",
          members: { create: { userId: f.owner.id, role: "owner" } },
        },
      });
      await db!.app.update({ where: { id: f.app.id }, data: { ownerWorkspaceId: stranger.id } });
      // Selected Agents: the installation names no Agent yet.
      await db!.appInstallation.update({
        where: { appId_workspaceId: { appId: f.app.id, workspaceId: f.workspace.id } },
        data: { agentAccess: "selected" },
      });
      await db!.appAgentInboundGrant.deleteMany({ where: { appId: f.app.id } });
      expect((await f.ask(f.scout.id)).body.status).toBe("pending");
      await db!.appInstallationAgent.create({
        data: {
          installationId: (
            await db!.appInstallation.findFirstOrThrow({
              where: { appId: f.app.id, workspaceId: f.workspace.id },
            })
          ).id,
          agentId: f.other.id,
        },
      });
      expect((await f.ask(f.other.id)).body.status).toBe("approved");
      await db!.appInstallation.update({
        where: { appId_workspaceId: { appId: f.app.id, workspaceId: f.workspace.id } },
        data: { agentAccess: "all" },
      });
      await db!.appAgentInboundRequest.deleteMany({ where: { appId: f.app.id } });
      expect((await f.ask(f.scout.id)).body.status).toBe("approved");
      await db!.workspace.delete({ where: { id: stranger.id } }).catch(() => {});
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a person's revocation stops the app's tokens and blocks an automatic regrant until a person approves",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      expect((await f.event(token, EVENT)).status).toBe(202);
      const grant = await db!.appAgentInboundGrant.findUniqueOrThrow({
        where: { appId_agentId: { appId: f.app.id, agentId: f.scout.id } },
      });
      // Another member may not revoke; the owner can.
      await expect(
        f.inbound.revoke(
          { workspaceId: f.workspace.id, userId: f.member.id },
          { agentId: f.scout.id, grantId: grant.id },
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await f.inbound.revoke(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        { agentId: f.scout.id, grantId: grant.id },
      );
      // The token it already holds stops at once.
      const refused = await f.event(token, EVENT);
      expect(refused.status).toBe(401);
      // The rule no longer approves: the app waits for a person.
      const regrant = await f.ask(f.scout.id);
      expect(regrant.body.status).toBe("pending");
      await f.inbound.approve(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        { agentId: f.scout.id, requestId: regrant.body.request_id },
      );
      expect(
        await db!.appAgentInboundGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ source: "approval", revokedAt: null });
      expect((await f.ask(f.scout.id)).body.status).toBe("approved");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "uninstalling the app revokes its grants, and an app no longer declaring a scope loses its tokens' scope",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      expect((await f.event(token, EVENT)).status).toBe(202);
      // The app stops declaring the scope: the token is insufficient_scope.
      await db!.app.update({
        where: { id: f.app.id },
        data: { allowedScopes: ["openid", "profile", "identity"] },
      });
      const narrowed = await f.event(token, EVENT);
      expect(narrowed.status).toBe(403);
      expect(narrowed.headers.get("www-authenticate")).toContain("insufficient_scope");
      await db!.app.update({ where: { id: f.app.id }, data: { allowedScopes: BOTH } });
      expect((await f.event(token, EVENT)).status).toBe(202);
      await db!.$transaction((tx) =>
        removeAppInstallations(tx, {
          appId: f.app.id,
          workspace: f.workspace.id,
          userId: f.owner.id,
          at: new Date(),
        }),
      );
      expect((await f.event(token, EVENT)).status).toBe(401);
      expect(
        await db!.appAgentInboundGrant.findUniqueOrThrow({
          where: { appId_agentId: { appId: f.app.id, agentId: f.scout.id } },
        }),
      ).toMatchObject({ revokedAt: expect.any(Date) });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "where app-agent-events is off nothing exists: requests, tokens and the page",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      const requested = await f.ask(f.scout.id);
      expect((await f.event(token, EVENT)).status).toBe(202);
      // The Workspace's slug no longer starts with the flag's prefix: the flag is off for it.
      await db!.workspace.update({
        where: { id: f.workspace.id },
        data: { slug: `off-${f.suffix}` },
      });
      expect(
        (await f.ask(f.scout.id, ["agent:event:write"], `off-${f.suffix}`)).response.status,
      ).toBe(404);
      expect((await f.event(token, EVENT)).status).toBe(401);
      const exchange = await f.exchange(requested.body.request_id);
      expect(exchange.body.error).toBe("unauthorized_client");
      const page = await f.inbound.list(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        f.scout.id,
      );
      expect(page).toMatchObject({ enabled: false, events: [], grants: [], pendingRequests: [] });
      expect(await db!.appAgentEvent.count({ where: { appId: f.app.id } })).toBe(1);
    } finally {
      await f.cleanup();
    }
  },
);
