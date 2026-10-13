import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  readSecretRootKey,
  rootIdentity,
} from "../../public-channel-memory/src/ov";
for (const line of (await Bun.file("/home/zhoujie22/river2_0/coforge/apps/web/.env").text()).split("\n")) {
  const m = line.match(/^(DATABASE_URL)=(.*)$/);
  if (m) Bun.env[m[1]] = m[2];
}
process.env.OPENVIKING_PROTOTYPE_CONF ??= "/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/infra/secrets/openviking_prototype_ov_conf";
const TODAY = [
  "evol-0c6d8347dfdc", "evol-9e79e48e6294", "evol-6e8391cf4de0", "evol-2110d7939c6b",
  "evol-646be5733a7b", "evol-dc935b6de1e8", "evol-5fddb009a000", "evol-a276e302daac", "evol-f78ff4fc8179",
];
const runtime = createEvalRuntime("http://127.0.0.1:1933");
const root = rootIdentity(await readSecretRootKey(process.env.OPENVIKING_PROTOTYPE_CONF));
for (const acct of TODAY) {
  try {
    await deleteDisposableAccount(runtime, root, acct);
    console.log("deleted ov account", acct);
  } catch (e) {
    console.log("FAIL", acct, String(e).slice(0, 100));
  }
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL }) });
const gone = await db.user.deleteMany({
  where: { username: { startsWith: "sb-eval-" }, createdAt: { lt: new Date("2026-10-10T12:58:00Z") } },
});
console.log("deleted orphan sb-eval users:", gone.count);
await db.$disconnect();
