import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillAttachmentImageDimensions } from "../src/server/attachments/attachment-image-dimensions-backfill.server";

type Args = {
  dryRun: boolean;
  cutoff: Date;
  maxItems: number;
  batchSize: number;
  batchDelayMs: number;
  after: { createdAt: Date; id: string } | undefined;
};
function usage(): never {
  throw new Error(
    "usage: --dry-run --cutoff <ISO> --max-items <n> [--batch-size <n>] [--batch-delay-ms <n>] [--after-created-at <ISO> --after-id <uuid>]",
  );
}
function integer(value: string | undefined) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) usage();
  return n;
}
function args(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const cutoff = get("--cutoff");
  const maxItems = get("--max-items");
  if (argv.includes("--dry-run") === argv.includes("--apply")) usage();
  if (!cutoff || !maxItems || !Number.isFinite(Date.parse(cutoff))) usage();
  const afterCreatedAt = get("--after-created-at");
  const afterId = get("--after-id");
  if (
    Boolean(afterCreatedAt) !== Boolean(afterId) ||
    (afterCreatedAt && !Number.isFinite(Date.parse(afterCreatedAt)))
  )
    usage();
  return {
    dryRun: argv.includes("--dry-run"),
    cutoff: new Date(cutoff),
    maxItems: integer(maxItems),
    batchSize: integer(get("--batch-size") ?? "25") || usage(),
    batchDelayMs: integer(get("--batch-delay-ms") ?? "100"),
    after:
      afterCreatedAt && afterId ? { createdAt: new Date(afterCreatedAt), id: afterId } : undefined,
  };
}

const options = args(Bun.argv.slice(2));
const db = requireDatabaseClient();
try {
  const summary = await backfillAttachmentImageDimensions({
    ...options,
    db,
    onBatch: (checkpoint) => console.log(JSON.stringify({ event: "batch", ...checkpoint })),
  });
  console.log(JSON.stringify(summary));
} finally {
  await db.$disconnect();
}
