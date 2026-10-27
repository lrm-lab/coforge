import { z } from "zod";
import { isValidReleaseVersion, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

export type ComputerRestartStatus =
  | { requestId: string; status: "accepted"; expiresAt: string }
  | {
      requestId: string;
      status: "completed";
      completedAt: string;
      workerInstanceId: string;
      daemonVersion: string;
      startedAt: number;
    }
  | { requestId: string; status: "failed"; reason: "timeout" | "publication" };

/** Which detail row owns a cloud upgrade: Version (runtime) or Image. */
export type ComputerUpgradeTarget = "runtime" | "image";

/** One upgrade operation's status, as `computer-upgrade-store.server.ts` stores and returns it. */
export type ComputerUpgradeStatus =
  | {
      requestId: string;
      status: "accepted";
      expectedVersion: string;
      expiresAt: string;
      /** Which detail row owns this upgrade. Set by the store for every public read. */
      target?: ComputerUpgradeTarget;
    }
  | {
      requestId: string;
      status: "completed";
      expectedVersion: string;
      computerVersion: string;
      daemonVersion: string;
      workerInstanceId: string;
      completedAt: string;
      target?: ComputerUpgradeTarget;
    }
  | {
      requestId: string;
      status: "failed";
      /** "reported" is the Computer's own terminal receipt; the others are server inferences. */
      reason: "timeout" | "publication" | "evidence" | "reported";
      error?: string;
      /** See `UPGRADE_ERROR_CODE`; only ever set alongside `reason: "reported"`. */
      errorCode?: string;
      target?: ComputerUpgradeTarget;
    }
  | { requestId: string; status: "unknown"; reason: "corrupt" };

export type ComputerAgentWorkspaceScan = {
  agentId: string;
  name: string;
  displayName: string;
  state: "active" | "deleted";
  status: "present" | "missing" | "unavailable" | "partial";
  rootPath: string;
  fileCount: number;
  totalSizeBytes: number;
  modifiedAtMs: number;
};

const runtimeInput = z.object({
  computerId: z.string().min(1),
  provider: z.enum(RUNTIME_PROVIDER),
});

export const computerIdInputSchema = z.object({ computerId: z.string().min(1) });
export const readCommandCodeEffortsInputSchema = computerIdInputSchema.extend({
  modelId: z.string().trim().min(1).max(300),
});
export const restartComputerInputSchema = z.object({
  computerId: z.string().min(1),
  requestId: z.uuid(),
});
export const upgradeComputerInputSchema = restartComputerInputSchema.extend({
  target: z.enum(["runtime", "image"]).optional(),
});
export const readRestartStatusInputSchema = restartComputerInputSchema;
export const scanUsageInputSchema = runtimeInput;
export const readUsageInputSchema = runtimeInput;
export const scanAgentWorkspacesInputSchema = computerIdInputSchema;
export const deleteAgentWorkspaceInputSchema = computerIdInputSchema.extend({
  agentId: z.string().min(1),
});
export const setRuntimeVisibilityInputSchema = z.object({
  runtimeId: z.string().min(1),
  isPublic: z.boolean(),
});
export const updateComputerDisplayNameInputSchema = z.object({
  computerId: z.string().min(1),
  displayName: z.string().trim().min(1).max(200),
});
export const formatCloudComputerInputSchema = z.object({
  computerId: z.string().min(1),
  confirmName: z.string().trim().min(1).max(200),
});
export const computerReleaseNotesInputSchema = z.object({
  version: z.string().refine(isValidReleaseVersion),
});
