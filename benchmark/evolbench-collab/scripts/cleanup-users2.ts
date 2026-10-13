import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
for (const line of (await Bun.file("/home/zhoujie22/river2_0/coforge/apps/web/.env").text()).split("\n")) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) Bun.env[m[1]] = m[2];
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL }) });
const stale = await db.user.findMany({
  where: { username: { startsWith: "sb-eval-" }, createdAt: { lt: new Date("2026-10-10T12:58:00Z") } },
  select: { id: true },
});
const ids = stale.map(u => u.id);
for (const [name, count] of Object.entries({
  agents: (await db.agent.deleteMany({ where: { ownerId: { in: ids } } })).count,
  daemonApiKeys: await db.daemonApiKey.deleteMany({ where: { computer: { ownerId: { in: ids } } } }).catch(e => { console.log("dk skip:", String(e).slice(0, 60)); return { count: 0 }; }).then(r => (r as any).count ?? 0),
})) console.log("deleted", name, count);
const c2 = await db.user.deleteMany({ where: { id: { in: ids } } });
console.log("deleted orphan sb-eval users:", c2.count);
await db.$disconnect();
