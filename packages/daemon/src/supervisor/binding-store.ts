import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import {
  LIFECYCLE_FAILURE_OPERATIONS,
  UPGRADE_OPERATION_HISTORY,
  type BindingStore,
  type ManagedBinding,
} from "./machine-supervisor";

const nonEmptyString = z.string().min(1);
const nonNegativeInt = z.int().min(0);

const lastFailureSchema = z.object({
  operation: z.enum(LIFECYCLE_FAILURE_OPERATIONS),
  message: nonEmptyString,
  at: nonNegativeInt,
});

const bindingBaseSchema = z.looseObject({
  workspaceId: nonEmptyString,
  computerId: nonEmptyString,
  workspaceRoot: nonEmptyString,
  enabled: z.boolean(),
});

const restartSchema = z.object({
  requestId: nonEmptyString,
  phase: z.enum(["stopping", "starting"]),
  previousInstanceId: z.union([z.null(), nonEmptyString]),
});

const restartResultSchema = z.discriminatedUnion("status", [
  z.object({
    requestId: nonEmptyString,
    status: z.literal("cancelled"),
    by: z.enum(["stop", "configure"]).optional(),
  }),
  z.object({
    requestId: nonEmptyString,
    status: z.literal("completed"),
    instanceId: nonEmptyString,
  }),
]);

const upgradeRequestIdsSchema = z
  .array(nonEmptyString)
  .max(128)
  .refine((ids) => new Set(ids).size === ids.length);

const upgradeRequestSchema = z.object({
  requestId: nonEmptyString,
  expectedVersion: nonEmptyString,
});

const upgradeOperationTerminalSchema = z.object({
  at: nonNegativeInt,
  version: nonEmptyString.optional(),
  error: nonEmptyString.optional(),
  deadProcessCount: nonNegativeInt.optional(),
});

const upgradeOperationBase = {
  requestId: nonEmptyString,
  expectedVersion: nonEmptyString,
  requestedAt: nonNegativeInt,
};

const upgradeOperationSchema = z.discriminatedUnion("state", [
  z.object({
    ...upgradeOperationBase,
    state: z.literal("pending"),
    terminal: z.undefined().optional(),
  }),
  z.object({
    ...upgradeOperationBase,
    state: z.literal("succeeded"),
    terminal: upgradeOperationTerminalSchema,
  }),
  z.object({
    ...upgradeOperationBase,
    state: z.literal("failed"),
    terminal: upgradeOperationTerminalSchema,
  }),
  z.object({
    ...upgradeOperationBase,
    state: z.literal("acknowledged"),
    terminal: upgradeOperationTerminalSchema.optional(),
  }),
]);

/** Coordinator-owned registry. File and directory sync bracket atomic replacement. */
export class FileBindingStore implements BindingStore {
  readonly #path: string;
  constructor(
    private readonly directory: string,
    private readonly expectedServerUrl?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.#path = join(directory, "bindings.json");
  }
  async load(): Promise<ManagedBinding[]> {
    let value: unknown;
    try {
      value = await Bun.file(this.#path).json();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    dropMalformedLastFailures(value);
    validateBindings(value);
    this.#assertEnvironment(value);
    return value.map((binding) => migrateLegacyUpgradeRequests(binding, this.now()));
  }
  async save(bindings: ManagedBinding[]): Promise<void> {
    validateBindings(bindings);
    this.#assertEnvironment(bindings);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    // FileHandle is required for sync; Bun.write alone does not expose this durability boundary.
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(bindings) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.#path);
      // Windows cannot fsync a directory handle (EPERM). The renamed file was already
      // synced above; skipping the directory sync keeps the registry durable without
      // failing the whole Coordinator configure path on win32.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #assertEnvironment(bindings: ManagedBinding[]) {
    if (!this.expectedServerUrl) return;
    for (const binding of bindings) {
      if (!binding.serverHttpUrl) throw new Error("Persisted binding does not identify its server");
      if (new URL(binding.serverHttpUrl).origin !== new URL(this.expectedServerUrl).origin)
        throw new Error("Binding server does not match this daemon build");
    }
  }
}

function validLastFailure(failure: unknown): boolean {
  return lastFailureSchema.safeParse(failure).success;
}

/** `lastFailure` is only a diagnostic for `status`: a malformed one is dropped on load rather
 * than taking the whole registry, and every Workspace in it, down. */
function dropMalformedLastFailures(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const binding of value)
    if (isRecord(binding) && "lastFailure" in binding && !validLastFailure(binding.lastFailure))
      delete binding.lastFailure;
}

function validateBindings(value: unknown): asserts value is ManagedBinding[] {
  if (!Array.isArray(value)) throw new Error("invalid binding registry");
  const ids = new Set<string>();
  for (const raw of value) {
    const base = bindingBaseSchema.safeParse(raw);
    if (!base.success || ids.has(base.data.workspaceId))
      throw new Error("invalid binding registry");
    const binding = base.data;
    ids.add(binding.workspaceId);
    let restartRequestId: string | undefined;
    if (binding.restart !== undefined) {
      const pending = restartSchema.safeParse(binding.restart);
      if (!binding.enabled || !pending.success) throw new Error("invalid binding registry restart");
      restartRequestId = pending.data.requestId;
    }
    if (binding.restartResults !== undefined) {
      if (!Array.isArray(binding.restartResults) || binding.restartResults.length > 128)
        throw new Error("invalid binding registry results");
      const requests = new Set<string>();
      for (const rawResult of binding.restartResults) {
        const result = restartResultSchema.safeParse(rawResult);
        if (!result.success || requests.has(result.data.requestId))
          throw new Error("invalid binding registry result");
        requests.add(result.data.requestId);
      }
      if (restartRequestId !== undefined && requests.has(restartRequestId))
        throw new Error("invalid binding registry conflicting restart");
    }
    if (binding.lastFailure !== undefined && !validLastFailure(binding.lastFailure))
      throw new Error("invalid binding registry last failure");
    if (
      binding.upgradeRequestIds !== undefined &&
      !upgradeRequestIdsSchema.safeParse(binding.upgradeRequestIds).success
    )
      throw new Error("invalid binding registry upgrade request IDs");
    if (binding.upgradeRequests !== undefined) {
      if (!Array.isArray(binding.upgradeRequests) || binding.upgradeRequests.length > 128)
        throw new Error("invalid binding registry upgrades");
      const requests = new Set<string>();
      for (const rawRequest of binding.upgradeRequests) {
        const request = upgradeRequestSchema.safeParse(rawRequest);
        if (!request.success || requests.has(request.data.requestId))
          throw new Error("invalid binding registry upgrade request");
        requests.add(request.data.requestId);
      }
    }
    validateUpgradeOperations(binding.upgradeOperations);
  }
}

/** One operation at a time may be pending, and every terminal state carries its receipt. */
function validateUpgradeOperations(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > UPGRADE_OPERATION_HISTORY)
    throw new Error("invalid binding registry upgrade operations");
  const seen = new Set<string>();
  let pending = 0;
  for (const rawOperation of value) {
    const operation = upgradeOperationSchema.safeParse(rawOperation);
    if (!operation.success || seen.has(operation.data.requestId))
      throw new Error("invalid binding registry upgrade operation");
    seen.add(operation.data.requestId);
    if (operation.data.state === "pending") pending += 1;
  }
  if (pending > 1) throw new Error("invalid binding registry upgrade operation overlap");
}

/**
 * Reopens the pre-receipt `upgradeRequests` dedupe list as pending operations. Those entries were
 * never cleared, so a machine can carry requests for versions it finished long ago; they become
 * ordinary pending operations that the receipt sweep resolves or that expire with the record cap.
 */
function migrateLegacyUpgradeRequests(binding: ManagedBinding, migratedAt: number): ManagedBinding {
  if (!binding.upgradeRequests?.length) return binding;
  const { upgradeRequests, ...rest } = binding;
  const existing = new Set((binding.upgradeOperations ?? []).map((entry) => entry.requestId));
  return {
    ...rest,
    upgradeOperations: [
      ...(binding.upgradeOperations ?? []),
      ...upgradeRequests
        .filter((request) => !existing.has(request.requestId))
        // Legacy entries carry no age of their own, so the migration itself starts their clock.
        .map((request) => ({ ...request, state: "pending" as const, requestedAt: migratedAt })),
    ].slice(-UPGRADE_OPERATION_HISTORY),
  };
}
