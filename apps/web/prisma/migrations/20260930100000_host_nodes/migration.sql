-- CreateTable
CREATE TABLE "host_nodes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "node_key" TEXT,
    "token_hash" TEXT NOT NULL,
    "registrar_user_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "host_nodes_node_key_key" ON "host_nodes"("node_key");

-- CreateIndex
CREATE UNIQUE INDEX "host_nodes_token_hash_key" ON "host_nodes"("token_hash");

-- CreateIndex
CREATE INDEX "host_nodes_last_seen_at_idx" ON "host_nodes"("last_seen_at");

-- AddForeignKey
ALTER TABLE "host_nodes" ADD CONSTRAINT "host_nodes_registrar_user_id_fkey" FOREIGN KEY ("registrar_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
