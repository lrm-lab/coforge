import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
const envPath = "/home/zhoujie22/river2_0/coforge/apps/web/.env";
for (const line of await Bun.file(envPath).text().then(t => t.split("\n"))) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) Bun.env[m[1]] = m[2];
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL }) });
const ws = await db.workspace.findMany({
  where: { slug: { startsWith: "evol-warm-" } },
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { id: true, slug: true, createdAt: true },
});
for (const w of ws) {
  console.log("workspace", w.slug, w.createdAt.toISOString());
  const agents = await db.agent.findMany({ where: { workspaceId: w.id }, select: { id: true, name: true, computerId: true, controlState: true } });
  for (const a of agents) {
    const cs: any = a.controlState;
    console.log("  agent", a.name, "computer:", a.computerId?.slice(0, 8), "phase:", cs?.phase, "error:", cs?.error ?? null);
  }
  const binding = await db.openVikingBinding.findUnique({ where: { workspaceId: w.id }, select: { accountId: true } });
  console.log("  binding account:", binding?.accountId ?? null);
}
const keys = await db.daemonApiKey.findMany({ orderBy: { createdAt: "desc" }, take: 5, select: { id: true, createdAt: true, revokedAt: true, computerId: true } });
console.log("latest daemon api keys:", keys.map(k => ({ id: k.id.slice(0, 8), at: k.createdAt.toISOString(), revoked: k.revokedAt !== null, computer: k.computerId?.slice(0, 8) })));
await db.$disconnect();
