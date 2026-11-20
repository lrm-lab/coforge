/**
 * Task #76 fixtures for a verify-web run: an Agent whose Computer's Workspace link is gone
 * (access revoked), an Agent with no Computer, and a linked Computer to move them to.
 * Idempotent: deterministic ids, reruns update in place. Needs DATABASE_URL and REDIS_URL of
 * the verify stack, same as `seed-dev-data.ts`.
 */
import { createHash } from "node:crypto";
import { RedisClient } from "bun";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { getDatabaseClient } from "../src/server/db/client.server";
import { workspaceIdForUser } from "../src/server/workspaces/enrollment.server";

const dbOrUndefined = getDatabaseClient();
if (!dbOrUndefined) throw new Error("DATABASE_URL is required to seed development data");
const db = dbOrUndefined;
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const redis = new RedisClient(redisUrl);

function stableId(seed: string): string {
  const hash = createHash("sha256").update(`coforge-t76-seed:${seed}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

const runtimeConfig = {
  runtime: "codex",
  provider: { kind: "default" },
  model: "gpt-5.1-codex",
  modelProvider: "",
  reasoning: "medium",
};

const workspaceId = await workspaceIdForUser(
  db,
  { ...DEV_BROWSER_USER, displayName: DEV_BROWSER_USER.name },
  "en",
);

// The move target: a Computer linked to this Workspace.
const deskId = stableId("computer:desk");
await db.computer.upsert({
  where: { id: deskId },
  create: {
    id: deskId,
    ownerId: DEV_BROWSER_USER.id,
    machineId: "t76-machine-desk",
    name: "t76-desk-mac",
    displayName: "T76 Desk Mac",
    computerVersion: "4.6.2",
    platform: "darwin",
    osVersion: "26.1",
    kind: "local",
  },
  update: { displayName: "T76 Desk Mac" },
});
await db.workspaceComputer.upsert({
  where: { workspaceId_computerId: { workspaceId, computerId: deskId } },
  create: { workspaceId, computerId: deskId },
  update: {},
});
await db.computerRuntime.upsert({
  where: {
    workspaceId_computerId_provider: {
      workspaceId,
      computerId: deskId,
      provider: "codex",
    },
  },
  create: {
    workspaceId,
    computerId: deskId,
    provider: "codex",
    version: "0.42.0",
    displayName: "Codex CLI",
    isPublic: true,
  },
  update: {},
});
await redis.set(
  `coforge:workspace:${encodeURIComponent(workspaceId)}:computer:${encodeURIComponent(deskId)}:status:v1`,
  "online",
  "EX",
  86400,
);

// The revoked Computer: owned by the same user but with no WorkspaceComputer link, so the
// Agent's recorded Computer is no longer reachable from this Workspace.
const studioId = stableId("computer:studio");
await db.computer.upsert({
  where: { id: studioId },
  create: {
    id: studioId,
    ownerId: DEV_BROWSER_USER.id,
    machineId: "t76-machine-studio",
    name: "t76-studio-mac",
    displayName: "Aleksandra's MacBook Pro (Engineering)",
    computerVersion: "4.6.2",
    platform: "darwin",
    osVersion: "26.1",
    kind: "local",
  },
  update: { displayName: "Aleksandra's MacBook Pro (Engineering)" },
});

const agentFields = {
  workspaceId,
  ownerId: DEV_BROWSER_USER.id,
  runtimeConfig,
};
const revokedAgentId = stableId("agent:revoked");
await db.agent.upsert({
  where: { id: revokedAgentId },
  create: {
    id: revokedAgentId,
    ...agentFields,
    name: "t76-release-notes",
    displayName: "Release Notes",
    description: "Writes the weekly release notes.",
    computerId: studioId,
  },
  update: { computerId: studioId, deletedAt: null },
});
const unassignedAgentId = stableId("agent:unassigned");
await db.agent.upsert({
  where: { id: unassignedAgentId },
  create: {
    id: unassignedAgentId,
    ...agentFields,
    name: "t76-field-notes",
    displayName: "Field Notes",
    description: "Collects field notes from customer calls.",
    computerId: null,
  },
  update: { computerId: null, deletedAt: null },
});
const readyAgentId = stableId("agent:ready");
await db.agent.upsert({
  where: { id: readyAgentId },
  create: {
    id: readyAgentId,
    ...agentFields,
    name: "t76-desk-hand",
    displayName: "Desk Hand",
    description: "An ordinary Agent on the linked Computer.",
    computerId: deskId,
  },
  update: { computerId: deskId, deletedAt: null },
});

console.log(
  JSON.stringify({
    workspaceId,
    deskId,
    studioId,
    revokedAgentId,
    unassignedAgentId,
    readyAgentId,
  }),
);
await db.$disconnect();
await redis.close();
