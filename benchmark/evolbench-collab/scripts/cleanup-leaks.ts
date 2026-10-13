import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
for (const line of (await Bun.file("/home/zhoujie22/river2_0/coforge/apps/web/.env").text()).split("\n")) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) Bun.env[m[1]] = m[2];
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL }) });
const CURRENT = "bbf6b260-242f-487b-8ce5-902ed8dd4086";
const dead = await db.workspace.findMany({
  where: { slug: { startsWith: "evol-warm-" }, createdAt: { lt: new Date("2026-10-10T12:58:00Z") } },
  select: { id: true, slug: true, createdAt: true },
});
const accounts: string[] = [];
for (const w of dead) {
  if (w.id === CURRENT) { console.log("SKIP current", w.slug); continue; }
  const b = await db.openVikingBinding.findUnique({ where: { workspaceId: w.id }, select: { accountId: true } });
  if (b?.accountId) accounts.push(b.accountId);
  await db.workspace.delete({ where: { id: w.id } }).catch((e) => console.log("ws del fail", w.slug, String(e).slice(0, 80)));
  console.log("deleted ws", w.slug, w.createdAt.toISOString(), "acct:", b?.accountId ?? "-");
}
console.log("accounts to delete (empty, dead segments):", accounts.join(",") || "(none)");
const users = await db.user.findMany({ where: { username: { startsWith: "sb-eval-" } }, select: { id: true, username: true } });
console.log("orphan sb-eval users:", users.length);
await db.$disconnect();
