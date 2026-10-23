import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import type { AgentDeliveryPush } from "#src/server/conversations/agent-delivery.server";
import { createAppAgentInbound } from "#src/server/app-agent-events/app-agent-events-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import {
  AGENT_REQUEST_GRANT_TYPE,
  agentInboundResource,
} from "#src/server/authorization-server/agent-inbound-tokens.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { ISSUER, SIGNING_KEYS, basic } from "./oidc-token-fixture";

/**
 * Agent inbound against local PostgreSQL with migrations applied, shared by its integration
 * tests: the real installation, grants and events behind the endpoints, and the
 * `app-agent-events` flag file (a Workspace slug starting with ON_SLUG has it on).
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
export const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
export const ON_SLUG = `agev-on-${RUN}`;
let flagDirectory: string | undefined;

/** Installs the flag file for the test file that calls it, and removes it after. */
export function useAgentEventsFlag() {
  beforeAll(async () => {
    if (!db) return;
    flagDirectory = await mkdtemp(join(tmpdir(), "coforge-agent-events-"));
    const path = join(flagDirectory, "flags.json");
    await Bun.write(
      path,
      JSON.stringify({
        $schema: "https://flagd.dev/schema/v0/flags.json",
        flags: {
          "app-agent-events": {
            state: "ENABLED",
            variants: { on: true, off: false },
            defaultVariant: "off",
            targeting: { if: [{ starts_with: [{ var: "workspaceSlug" }, ON_SLUG] }, "on", "off"] },
          },
        },
      }),
    );
    await installFeatureFlags(
      await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
    );
  });

  afterAll(async () => {
    await installFeatureFlags({ status: "disabled" });
    if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
    await db?.$disconnect();
  });
}

export const BOTH = [
  "openid",
  "profile",
  "identity",
  "agent:event:write",
  "agent:notification:write",
];

/** A Workspace with an owner, a member, two Agents and an app the owner registered. */
export async function fixture(db: PrismaClient, allowedScopes = BOTH) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = (name: string) =>
    db.user.create({ data: { displayName: `${name}-${suffix}`, username: `${name}-${suffix}` } });
  const [owner, member] = await Promise.all([user("owner"), user("member")]);
  const workspace = await db.workspace.create({
    data: {
      slug: `${ON_SLUG}${suffix}`,
      name: "Events",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const computer = await db.computer.create({
    data: { name: `c-${suffix}`, machineId: `m-${suffix}`, ownerId: owner.id },
  });
  const agent = (name: string, ownerId = owner.id) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId,
        computerId: computer.id,
        runtimeConfig: {},
      },
    });
  const [scout, other] = await Promise.all([agent("scout"), agent("other")]);
  const actor = { workspaceId: workspace.id, actorUserId: owner.id };
  const key = `agev-${suffix}`;
  const { clientSecret } = await createAppRegistry(db).registerApp(actor, {
    key,
    name: "Acme Meetings",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "productivity",
    allowedScopes,
  });
  const pushes: AgentDeliveryPush[] = [];
  const endpoints = createTokenEndpoints({
    issuer: ISSUER,
    signingKeys: SIGNING_KEYS,
    db,
    agentEventPush: () => async (_workspaceId, push) => {
      pushes.push(push);
    },
  });
  const app = await db.app.findUniqueOrThrow({ where: { key } });
  const authorization = basic(key, clientSecret);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://coforge.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  /** The app asks for `scopes` for `agentId`; the parsed answer. */
  const ask = async (agentId: string, scopes = ["agent:event:write"], slug = workspace.slug) => {
    const response = await endpoints.agentInbound.request(
      post(
        "/api/app-agent-requests",
        { workspace_slug: slug, agent_id: agentId, scopes },
        {
          authorization,
        },
      ),
    );
    return { response, body: (await response.json()) as Record<string, any> };
  };
  const exchange = async (requestId: string, resource?: string) => {
    const response = await endpoints.token.exchange(
      new Request("https://coforge.example/oidc/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization },
        body: new URLSearchParams({
          grant_type: AGENT_REQUEST_GRANT_TYPE,
          request_id: requestId,
          resource: resource ?? agentInboundResource(ISSUER, workspace.id),
        }),
      }),
    );
    return { response, body: (await response.json()) as Record<string, any> };
  };
  /** A token for `agentId`, through an approved request. */
  const tokenFor = async (agentId: string, scopes = ["agent:event:write"]) => {
    const requested = await ask(agentId, scopes);
    expect(requested.body.status).toBe("approved");
    const issued = await exchange(requested.body.request_id);
    expect(issued.response.status).toBe(200);
    return issued.body.access_token as string;
  };
  /** The app reads its own request back (`auth` defaults to its own credentials). */
  const statusOf = async (requestId: string, auth = authorization) => {
    const response = await endpoints.agentInbound.status(
      new Request(`https://coforge.example/api/app-agent-requests/${requestId}`, {
        headers: { authorization: auth },
      }),
      requestId,
    );
    return { response, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  const event = (token: string | undefined, body: unknown) =>
    endpoints.agentInbound.post(
      post("/api/app-agent-events", body, token ? { authorization: `Bearer ${token}` } : {}),
    );
  return {
    db,
    owner,
    member,
    workspace,
    scout,
    other,
    app,
    key,
    suffix,
    pushes,
    endpoints,
    ask,
    exchange,
    statusOf,
    authorization,
    tokenFor,
    event,
    post,
    inbound: createAppAgentInbound(db),
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.app.deleteMany({ where: { id: app.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { id: computer.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } }).catch(() => {});
    },
  };
}

export const EVENT = { kind: "event", summary: "Weekly sync has started" };
