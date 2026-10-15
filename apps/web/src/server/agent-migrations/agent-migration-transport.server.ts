import { z } from "zod";
import {
  agentMigrationRoleOf,
  type AgentMigrationRecord,
  type AgentMigrationRole,
  type AgentMigrations,
  type AgentMigrationStep,
  type MigrationParticipant,
} from "./agent-migrations.server";

/**
 * What the two Computers of a migration ask the server for while the workspace moves, over HTTPS
 * with their daemon API key: their view of the migration, a presigned upload per chunk for the
 * source, the stored manifest and a presigned download per chunk for the target, and the steps and
 * failures the state machine (`agent-migrations.server.ts`) rules on. Bytes never pass through the
 * server; they go straight between each Computer and the migration bucket, as in the reference
 * Computer. Chunk objects are keyed by their digest and written with overwrite refused, so a source
 * that retries a chunk already uploaded gets a conflict from the bucket it can treat as done. The
 * upload completes only once every chunk the manifest names is in the bucket at its size, so the
 * target never waits on a chunk that will not arrive. Each URL is signed per chunk when asked for,
 * so a long transfer never holds an expired one: a daemon asks again instead of retrying it.
 */

/** The migration bucket, as this module needs it: object sizes and presigned PUTs and GETs. */
export type AgentMigrationObjectStore = {
  head(objectKey: string): Promise<{ sizeBytes: number } | null>;
  presignPut(
    objectKey: string,
    input: { contentType: string; expiresInSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(objectKey: string, input: { expiresInSeconds: number }): Promise<string>;
};

const PRESIGN_SECONDS = 15 * 60;
const CHUNK_CONTENT_TYPE = "application/octet-stream";
/** The bundle writer's limits (`bundle-writer.ts` in the Daemon); a manifest past them is not its. */
const MAX_CHUNKS = 2048;
const MIN_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 2_000_000;
/** Chunk HEADs in flight while an upload completes. */
const HEAD_CONCURRENCY = 16;
const SHA256 = /^[0-9a-f]{64}$/;

const chunkSchema = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_CHUNKS - 1),
  offsetBytes: z.number().int().min(0),
  sizeBytes: z.number().int().min(1).max(MAX_CHUNK_BYTES),
  sha256: z.string().regex(SHA256),
});

/** The bundle manifest the source's bundle writer produces (`bundle-writer.ts` in the Daemon). */
export const agentMigrationManifestSchema = z
  .strictObject({
    format: z.literal("tar+gzip"),
    contentType: z.literal("application/vnd.coforge.agent-migration-bundle+tar+gzip"),
    entryCount: z.number().int().min(0).max(MAX_ENTRIES),
    expandedBytes: z.number().int().min(0),
    maxEntryBytes: z.number().int().min(0),
    memoryMdPresent: z.boolean(),
    notesPresent: z.boolean(),
    sizeBytes: z.number().int().min(1).max(MAX_BUNDLE_BYTES),
    sha256: z.string().regex(SHA256),
    chunkSizeBytes: z.number().int().min(MIN_CHUNK_BYTES).max(MAX_CHUNK_BYTES),
    chunks: z.array(chunkSchema).min(1).max(MAX_CHUNKS),
  })
  .refine((manifest) => {
    if (manifest.maxEntryBytes > manifest.expandedBytes) return false;
    let offset = 0;
    for (const [position, entry] of manifest.chunks.entries()) {
      if (entry.index !== position || entry.offsetBytes !== offset) return false;
      // Every chunk but the last is exactly the chunk size.
      const last = position === manifest.chunks.length - 1;
      if (
        last
          ? entry.sizeBytes > manifest.chunkSizeBytes
          : entry.sizeBytes !== manifest.chunkSizeBytes
      )
        return false;
      offset += entry.sizeBytes;
    }
    return offset === manifest.sizeBytes;
  });

export type AgentMigrationManifest = z.infer<typeof agentMigrationManifestSchema>;

export type AgentMigrationChunk = z.infer<typeof chunkSchema>;

/** A chunk's object key: under the Agent's Workspace prefix, per attempt, named by its digest. */
export function agentMigrationChunkKey(input: {
  workspaceId: string;
  agentId: string;
  migrationId: string;
  generation: number;
  index: number;
  sha256: string;
}) {
  return `workspaces/${input.workspaceId}/agents/${input.agentId}/migrations/${input.migrationId}/${input.generation}/chunks/${input.index}-${input.sha256}`;
}

type Refused<Code extends string> = { status: "refused"; code: Code };

/** A migration `AgentMigrations.view` returned is one of the participant's, so it has a role. */
const roleOf = (migration: AgentMigrationRecord, participant: MigrationParticipant) =>
  agentMigrationRoleOf(migration, participant) as AgentMigrationRole;

/** The states in which the target may still fetch chunks. */
const DOWNLOADABLE = new Set(["uploaded", "placing"]);

export class AgentMigrationTransport {
  constructor(
    private readonly migrations: AgentMigrations,
    /** Null when this deployment has no migration bucket: transfers are then unavailable. */
    private readonly objects: AgentMigrationObjectStore | null,
  ) {}

  /** The migration as one of its two Computers sees it, with the manifest once uploaded. */
  async view(participant: MigrationParticipant, migrationId: string) {
    const migration = await this.migrations.view(participant, migrationId);
    if (!migration) return null;
    const manifest = await this.#manifest(migration);
    return {
      migration: {
        id: migration.id,
        agentId: migration.agentId,
        role: roleOf(migration, participant),
        state: migration.state,
        generation: migration.generation,
        revision: migration.revision,
        sourceComputerId: migration.sourceComputerId,
        targetComputerId: migration.targetComputerId,
      },
      manifest,
    };
  }

  /** A presigned PUT for one chunk, for the source, once it has stopped the Agent. */
  async uploadUrl(
    participant: MigrationParticipant,
    input: { migrationId: string; generation: number; chunk: unknown },
  ): Promise<
    | { status: "ok"; url: string; headers: Record<string, string> }
    | Refused<
        | "not_found"
        | "wrong_computer"
        | "stale_generation"
        | "invalid_state"
        | "invalid_chunk"
        | "unavailable"
      >
  > {
    const migration = await this.migrations.view(participant, input.migrationId);
    if (!migration) return { status: "refused", code: "not_found" };
    if (roleOf(migration, participant) !== "source")
      return { status: "refused", code: "wrong_computer" };
    if (input.generation !== migration.generation)
      return { status: "refused", code: "stale_generation" };
    if (migration.state !== "source_stopped") return { status: "refused", code: "invalid_state" };
    const chunk = chunkSchema.safeParse(input.chunk);
    if (!chunk.success) return { status: "refused", code: "invalid_chunk" };
    if (!this.objects) return { status: "refused", code: "unavailable" };
    const issued = await this.objects.presignPut(this.#key(migration, chunk.data), {
      contentType: CHUNK_CONTENT_TYPE,
      expiresInSeconds: PRESIGN_SECONDS,
    });
    return { status: "ok", ...issued };
  }

  /** A presigned GET for one chunk of the stored manifest, for the target, while it places. */
  async downloadUrl(
    participant: MigrationParticipant,
    input: { migrationId: string; generation: number; index: number },
  ): Promise<
    | { status: "ok"; url: string }
    | Refused<
        | "not_found"
        | "wrong_computer"
        | "stale_generation"
        | "invalid_state"
        | "invalid_chunk"
        | "unavailable"
      >
  > {
    const migration = await this.migrations.view(participant, input.migrationId);
    if (!migration) return { status: "refused", code: "not_found" };
    if (roleOf(migration, participant) !== "target")
      return { status: "refused", code: "wrong_computer" };
    if (input.generation !== migration.generation)
      return { status: "refused", code: "stale_generation" };
    if (!DOWNLOADABLE.has(migration.state)) return { status: "refused", code: "invalid_state" };
    const entry = (await this.#manifest(migration))?.chunks[input.index];
    if (!entry) return { status: "refused", code: "invalid_chunk" };
    if (!this.objects) return { status: "refused", code: "unavailable" };
    const url = await this.objects.presignGet(this.#key(migration, entry), {
      expiresInSeconds: PRESIGN_SECONDS,
    });
    return { status: "ok", url };
  }

  /**
   * The source's `upload_complete`, carrying a manifest checked to describe whole chunks, each of
   * which must already be in the bucket at its size.
   */
  async completeUpload(
    participant: MigrationParticipant,
    input: { migrationId: string; generation: number; expectedRevision: number; manifest: unknown },
  ) {
    const migration = await this.migrations.view(participant, input.migrationId);
    if (!migration) return { status: "refused" as const, code: "not_found" as const };
    if (roleOf(migration, participant) !== "source")
      return { status: "refused" as const, code: "wrong_computer" as const };
    const manifest = agentMigrationManifestSchema.safeParse(input.manifest);
    if (!manifest.success) return { status: "refused" as const, code: "invalid_manifest" as const };
    if (input.generation !== migration.generation)
      return { status: "refused" as const, code: "stale_generation" as const };
    // A future revision must not become current between this read and advance's read: it would
    // otherwise skip HEADs here and then become an accepting transition there. Older revisions
    // still reach advance, which preserves already-applied retries.
    if (input.expectedRevision > migration.revision)
      return { status: "refused" as const, code: "stale_revision" as const };
    // Only a pending completion needs storage. Let the state machine answer refusals and applied
    // retries independently of the bucket, and recheck its revision after the HEADs.
    if (input.expectedRevision === migration.revision && migration.state === "source_stopped") {
      if (!this.objects) return { status: "refused" as const, code: "unavailable" as const };
      if (!(await this.#allUploaded(migration, manifest.data)))
        return { status: "refused" as const, code: "chunks_missing" as const };
    }
    return this.migrations.advance(participant, {
      migrationId: input.migrationId,
      generation: input.generation,
      expectedRevision: input.expectedRevision,
      step: "upload_complete",
      manifest: manifest.data,
    });
  }

  /** Any other step; `upload_complete` goes through `completeUpload`, which carries the manifest. */
  async step(
    participant: MigrationParticipant,
    input: {
      migrationId: string;
      generation: number;
      expectedRevision: number;
      step: Exclude<AgentMigrationStep, "upload_complete">;
    },
  ) {
    if (!(await this.migrations.view(participant, input.migrationId)))
      return { status: "refused" as const, code: "not_found" as const };
    return this.migrations.advance(participant, input);
  }

  async fail(
    participant: MigrationParticipant,
    input: { migrationId: string; generation: number; errorCode: string; errorDetail?: string },
  ) {
    return this.migrations.fail(participant, input);
  }

  async #manifest(migration: AgentMigrationRecord) {
    const stored = await this.migrations.manifest(migration);
    const manifest = stored ? agentMigrationManifestSchema.safeParse(stored) : null;
    return manifest?.success ? manifest.data : null;
  }

  async #allUploaded(migration: AgentMigrationRecord, manifest: AgentMigrationManifest) {
    const objects = this.objects!;
    let next = 0;
    let complete = true;
    const worker = async () => {
      while (complete && next < manifest.chunks.length) {
        const entry = manifest.chunks[next++]!;
        const found = await objects.head(this.#key(migration, entry));
        if (found?.sizeBytes !== entry.sizeBytes) complete = false;
      }
    };
    await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, worker));
    return complete;
  }

  #key(migration: AgentMigrationRecord, entry: Pick<AgentMigrationChunk, "index" | "sha256">) {
    return agentMigrationChunkKey({
      workspaceId: migration.workspaceId,
      agentId: migration.agentId,
      migrationId: migration.id,
      generation: migration.generation,
      index: entry.index,
      sha256: entry.sha256,
    });
  }
}
