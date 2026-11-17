import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import {
  authenticateExternalAgentKey,
  issueExternalAgentPageCredential,
  mintExternalAgentCredential,
} from "#src/server/agents/external-agent-credentials.server";
import { externalSetups } from "#src/server/agents/external-agent-presence.server";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("CHANNEL_TEST_DATABASE_URL must point at a scratch PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const suffixes: string[] = [];

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  suffixes.push(suffix);
  const owner = await db.user.create({
    data: { displayName: `x-${suffix}`, username: `x-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: `x-${suffix}`, name: "External credentials" },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `agent-${suffix}`,
      displayName: "External",
      ownerId: owner.id,
      hosting: "external",
      runtimeConfig: {},
    },
  });
  const repository = new PrismaExternalAgentCredentialRepository(db);
  const issue = () =>
    issueExternalAgentPageCredential({
      repository,
      agentId: agent.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
  const device = () =>
    mintExternalAgentCredential({
      repository,
      agentId: agent.id,
      workspaceId: workspace.id,
      approvedByUserId: owner.id,
      source: "device",
      machine: { machineName: "m", hostname: "h", os: "o", clientName: "c" },
    });
  return { agent, owner, repository, issue, device };
}

describe("PrismaExternalAgentCredentialRepository", () => {
  afterEach(async () => {
    for (const suffix of suffixes.splice(0)) {
      await db.workspace.deleteMany({ where: { slug: `x-${suffix}` } });
      await db.user.deleteMany({ where: { username: `x-${suffix}` } });
    }
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  test("racing page credentials leave exactly one live, and device credentials are untouched", async () => {
    const f = await fixture();
    const device = await f.device();
    expect(device.ok).toBe(true);
    await Promise.all([f.issue(), f.issue(), f.issue()]);
    const rows = await db.externalAgentCredential.findMany({ where: { agentId: f.agent.id } });
    const app = rows.filter((row) => row.source === "app");
    expect(app).toHaveLength(3);
    expect(app.filter((row) => !row.revokedAt)).toHaveLength(1);
    expect(
      app.filter((row) => row.revokedAt).every((row) => row.revokedReason === "replaced"),
    ).toBe(true);
    expect(
      app.every((row) => row.machineName === null && row.approvedByUserId === f.owner.id),
    ).toBe(true);
    expect(rows.filter((row) => row.source === "device" && !row.revokedAt)).toHaveLength(1);
  });

  test("presence is one grouped read: waiting, online, offline, disconnected", async () => {
    const f = await fixture();
    const now = Date.now();
    expect((await externalSetups(f.repository, [f.agent.id], now)).get(f.agent.id)).toEqual({
      state: "waiting",
      lastSeenAt: null,
    });
    const first = await f.issue();
    expect((await externalSetups(f.repository, [f.agent.id], now)).get(f.agent.id)?.state).toBe(
      "waiting",
    );
    await authenticateExternalAgentKey(first.key, f.repository, () => now - 60_000);
    expect((await externalSetups(f.repository, [f.agent.id], now)).get(f.agent.id)?.state).toBe(
      "online",
    );
    expect(
      (await externalSetups(f.repository, [f.agent.id], now + 3 * 60_000)).get(f.agent.id)?.state,
    ).toBe("offline");
    const second = await f.issue();
    expect((await externalSetups(f.repository, [f.agent.id], now)).get(f.agent.id)?.state).toBe(
      "waiting",
    );
    await f.repository.revoke(second.credentialId, "revoked", new Date(now));
    expect((await externalSetups(f.repository, [f.agent.id], now)).get(f.agent.id)?.state).toBe(
      "disconnected",
    );
  });
});
