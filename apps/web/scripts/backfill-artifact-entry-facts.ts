import { requireDatabaseClient } from "../src/server/db/client.server";
import { productionArtifacts } from "../src/server/artifacts/artifact-composition.server";
import { backfillArtifactEntryFacts } from "../src/server/artifacts/artifact-entry-facts-backfill.server";

const argv = Bun.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const usage = "usage: --dry-run | --apply [--from-id <uuid>] [--batch-size <n>]";
const batchSize = Number(flag("--batch-size") ?? 200);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(usage);
const apply = argv.includes("--apply");
if (apply === argv.includes("--dry-run")) throw new Error(usage);

const db = requireDatabaseClient();
try {
  const summary = await backfillArtifactEntryFacts({
    db,
    documents: productionArtifacts(db).documents,
    dryRun: !apply,
    batchSize,
    after: flag("--from-id"),
    onBatch: (checkpoint) => console.log(JSON.stringify({ event: "batch", ...checkpoint })),
  });
  console.log(JSON.stringify(summary));
} finally {
  await db.$disconnect();
}
