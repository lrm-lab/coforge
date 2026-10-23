import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { DaemonConnection, startAgentProxy } from "@lrm/coforge-daemon";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAgentApiKey } from "#src/server/agents/agent-api-key.server";
import { createAppAgentAccess } from "#src/server/app-agent-access/app-agent-access-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { createDaemonApiKeyFactory } from "#src/server/auth/daemon-api-key.server";
import { AppGrantActionCards } from "#src/server/conversations/app-grant-action-cards.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";

/**
 * `coforge app list` and `coforge app token` end to end: the real CLI, through the daemon's local
 * Agent proxy and its cloud connection, against a running Web — the token reaches the program on
 * file descriptor 3 and nowhere else, verifies against the issuer's JWKS, and after a revoke the
 * approval card a person commits lets the next run through.
 *
 * Opt-in like the other E2Es. Needs a local Web started with `COFORGE_OIDC_ISSUER` (and its
 * signing keyset) set, `COFORGE_E2E_WEB_URL` pointing at it and `DATABASE_URL` at its database.
 * Creates its own people, Workspace, Computer, Agent and app, and removes them. Writes
 * `.amp/e2e/agent-app-tokens/run.md` (no token in it: only what the CLI printed, redacted).
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-app-tokens");
const cli = join(import.meta.dir, "../../../packages/coforge/src/cli.ts");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const suffix = crypto.randomUUID().slice(0, 8);
const log: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  await db.$disconnect();
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "run.md"), `${log.join("\n")}\n`);
});

/** Runs the real `coforge` CLI as the Agent, through the local proxy. */
async function coforge(env: Record<string, string>, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  log.push(`$ coforge ${args.map((arg) => (/\s/.test(arg) ? `'${arg}'` : arg)).join(" ")}`);
  log.push(
    "```",
    `exit ${code}`,
    "stdout:",
    stdout.trimEnd(),
    "stderr:",
    stderr.trimEnd(),
    "```",
    "",
  );
  return { code, stdout, stderr };
}

test("an Agent lists its apps, runs a program with a token, and waits for an approval card", async () => {
  const discovery = (await (
    await fetch(`${origin}/oidc/.well-known/openid-configuration`)
  ).json()) as {
    issuer: string;
    jwks_uri: string;
  };
  const people = await Promise.all(
    ["owner", "creator"].map((name) =>
      db.user.create({ data: { username: `tok-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const [owner, creator] = people as [(typeof people)[0], (typeof people)[0]];
  cleanups.push(() => db.user.deleteMany({ where: { id: { in: people.map(({ id }) => id) } } }));
  const workspace = await db.workspace.create({
    data: {
      slug: `tok-${suffix}`,
      name: "Agent app tokens",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: creator.id, role: "member" },
        ],
      },
    },
  });
  cleanups.push(() => db.workspace.delete({ where: { id: workspace.id } }));
  const computer = await db.computer.create({
    data: {
      ownerId: creator.id,
      machineId: `tok-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  cleanups.push(() => db.computer.delete({ where: { id: computer.id } }));
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `notetaker-${suffix}`,
      displayName: "Notetaker",
      ownerId: creator.id,
      computerId: computer.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `ops-${suffix}`,
      members: { create: [{ userId: owner.id }, { userId: creator.id }, { agentId: agent.id }] },
    },
  });
  const appKey = `acme-notes-${suffix}`;
  await createAppRegistry(db).registerApp(
    { workspaceId: workspace.id, actorUserId: owner.id },
    {
      key: appKey,
      name: "Acme Notes",
      description: "The team's notes.",
      whenToUse: "Read or write the team's notes.",
      homepageUrl: "https://notes.acme.example/",
      redirectUris: [],
      category: "productivity",
      allowedScopes: ["openid", "profile", "identity"],
    },
  );

  // The daemon's side: its connection to this Web with the Computer's key, and the local proxy
  // the CLI reaches with the Agent's context.
  const agentApiKey = await createAgentApiKey({
    agentId: agent.id,
    workspaceId: workspace.id,
    ownerId: creator.id,
    computerId: computer.id,
    repository: new PrismaAgentApiKeyRepository(db),
  });
  const daemonApiKey = await createDaemonApiKeyFactory(new PrismaDaemonApiKeyRepository(db)).create(
    { principal: { userId: creator.id }, workspaceId: workspace.id, computerId: computer.id },
  );
  let connected = () => {};
  const connection = new DaemonConnection("wss://unused.example", () => ({
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect: () => connected(),
    disconnect() {},
    rpc: async () => new Uint8Array(),
  }));
  await connection.start(daemonApiKey, {
    computerId: computer.id,
    workspaceId: workspace.id,
    serverHttpUrl: origin,
  });
  cleanups.push(() => connection.stop());
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentApp: async (_context, request, key) => connection.agentApp(request, key),
    },
  });
  cleanups.push(async () => proxy.close());
  const env = {
    COFORGE_AGENT_CONTEXT: proxy.issue(agent.id, agentApiKey),
    COFORGE_AGENT_PROXY_URL: proxy.url,
  };
  log.push(
    "# coforge app list / app token through the daemon proxy",
    "",
    `Web ${origin}, issuer ${discovery.issuer}, app \`${appKey}\`, Agent \`${agent.name}\`.`,
    "",
  );

  const listed = await coforge(env, ["app", "list"]);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain(`${appKey} — Acme Notes`);
  expect(listed.stdout).toContain("Access: granted on first use");
  expect(listed.stdout).not.toContain("system.cleaner");

  // The program reads the token from fd 3 and prints its claims (not the token); its own echo of
  // the token, or of its signature, comes back redacted, and its environment holds no CoForge
  // credential.
  const program = [
    't=$(cat <&"$COFORGE_APP_TOKEN_FD")',
    'echo "token: $t"',
    'echo "signature: ${t##*.}"',
    'printf "%s" "$t" | cut -d. -f2 | tr "_-" "/+" | base64 -d 2>/dev/null; echo',
    'env | cut -d= -f1 | sort | tr "\\n" " "; echo',
  ].join("; ");
  const ran = await coforge(env, [
    "app",
    "token",
    "--app",
    appKey,
    "--exec",
    "sh",
    "--",
    "-c",
    program,
  ]);
  expect(ran.code).toBe(0);
  expect(ran.stdout).toContain("token: [REDACTED]");
  expect(ran.stdout).toContain("signature: [REDACTED]");
  expect(ran.stdout).toContain('"type":"agent"');
  expect(ran.stdout).toContain(`"sub":"${agent.id}"`);
  expect(ran.stdout).not.toContain("COFORGE_AGENT_CONTEXT");
  expect(ran.stdout).not.toContain("HOME");

  // The same token, asked for directly, verifies against the issuer's JWKS with the app as audience.
  const answer = (await (
    await fetch(`${origin}/api/agent/v1/apps/${appKey}/token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${agentApiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
    })
  ).json()) as { access_token: string };
  const { payload, protectedHeader } = await jwtVerify(
    answer.access_token,
    createRemoteJWKSet(new URL(discovery.jwks_uri)),
    { issuer: discovery.issuer, audience: appKey, typ: "at+jwt" },
  );
  expect(payload).toMatchObject({
    client_id: appKey,
    type: "agent",
    workspace_slug: workspace.slug,
  });
  expect(payload.exp! - payload.iat!).toBe(300);
  log.push(
    "Direct `POST /api/agent/v1/apps/{key}/token`: verified against `jwks_uri`",
    `(\`kid\` ${protectedHeader.kid}, \`typ\` ${protectedHeader.typ}), claims:`,
    "```json",
    JSON.stringify({ ...payload, jti: "…" }, null, 2),
    "```",
    "",
  );

  // A person revokes the Agent's access: the next run waits for approval and posts one card.
  const access = createAppAgentAccess(db);
  const { grants } = await access.list({ workspaceId: workspace.id, userId: owner.id }, agent.id);
  await access.revoke(
    { workspaceId: workspace.id, userId: owner.id },
    { agentId: agent.id, grantId: grants[0]!.id },
  );
  const target = `#${channel.channelName}`;
  const waiting = await coforge(env, [
    "app",
    "token",
    "--app",
    appKey,
    "--target",
    target,
    "--exec",
    "true",
  ]);
  expect(waiting.code).toBe(2);
  expect(waiting.stderr).toContain("needs a person's approval");
  const again = await coforge(env, ["app", "token", "--app", appKey, "--exec", "true"]);
  expect(again.code).toBe(2);
  const cards = await db.actionCard.findMany({ where: { workspaceId: workspace.id } });
  expect(cards).toHaveLength(1);
  expect(waiting.stderr).toContain(cards[0]!.messageId);

  await new AppGrantActionCards(db).commit(
    { workspaceId: workspace.id, userId: creator.id },
    cards[0]!.messageId,
    access,
  );
  log.push(`The Agent's creator approved card ${cards[0]!.messageId}.`, "");
  const approved = await coforge(env, [
    "app",
    "token",
    "--app",
    appKey,
    "--exec",
    "sh",
    "--",
    "-c",
    'test -n "$(cat <&3)" && echo ok',
  ]);
  expect(approved).toMatchObject({ code: 0, stdout: "ok\n" });
}, 60_000);
