SET lock_timeout = '5s';

CREATE TABLE "message_reference_backfill_runs" (
    "id" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "finishedAt" TIMESTAMP(3),
    "fromId" UUID,
    "toId" UUID,
    "written" INTEGER NOT NULL,

    CONSTRAINT "message_reference_backfill_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_reference_backfill_rows" (
    "runId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "message_reference_backfill_rows_pkey" PRIMARY KEY ("runId", "messageId", "ordinal"),
    CONSTRAINT "message_reference_backfill_rows_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "message_reference_backfill_runs" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

RESET lock_timeout;
