import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { RuntimeSelection } from "./agent-runtime-fields-state";
import { isPiBuiltinModelProvider, KEYED_MODEL_PROVIDERS } from "./agent.schemas";
import { modelSizesApply } from "./agent-model-sizes";

export type BatchRuntimePreviewAgent = {
  id: string;
  displayName: string;
  ownedByCurrentUser: boolean;
  stopped: boolean;
  hasApiKey: boolean;
  provider?: RuntimeProvider;
  runtimeConfig?: {
    model?: string;
    modelProvider?: string;
    reasoning?: string;
    fastMode?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
  };
  runtimeConfigInvalid?: boolean;
};

export type BatchEnvPatch = {
  set: Record<string, string>;
  remove: string[];
};

export type ParsedBatchEnvPatch = BatchEnvPatch & {
  conflictKeys: string[];
  hasAny: boolean;
};

export type BatchAgentEnvSummary = {
  added: string[];
  updated: string[];
  removed: string[];
};

export type BatchAgentPlanKind = "unchanged" | "when-idle" | "restart" | "deferred";

export type BatchAgentPreviewRow = {
  agent: BatchRuntimePreviewAgent;
  runtimeChanged: boolean;
  providerChanged: boolean;
  envChanged: boolean;
  envSummary: BatchAgentEnvSummary;
  plan: BatchAgentPlanKind;
};

export type BatchRuntimePreviewPlan = {
  editableAgents: BatchRuntimePreviewAgent[];
  excludedCount: number;
  rows: BatchAgentPreviewRow[];
  changedCount: number;
  unchangedCount: number;
  whenIdleCount: number;
  willRestartCount: number;
  deferredCount: number;
  needsApiKey: boolean;
  missingApiKey: boolean;
};

export function buildInitialBatchRuntimeSelection(
  agents: readonly BatchRuntimePreviewAgent[],
  fallbackProvider: RuntimeProvider = RUNTIME_PROVIDER.COFORGE,
): RuntimeSelection {
  const editable = agents.filter((agent) => agent.ownedByCurrentUser && agent.provider);
  const first = editable[0];
  if (!first?.provider) {
    return {
      provider: fallbackProvider,
      modelProvider: "",
      model: "",
      reasoning: "",
      fastMode: false,
    };
  }
  const sameProvider = editable.every((agent) => agent.provider === first.provider);
  const sameModelProvider =
    sameProvider &&
    editable.every(
      (agent) =>
        (agent.runtimeConfig?.modelProvider ?? "") === (first.runtimeConfig?.modelProvider ?? ""),
    );
  const sameModel =
    sameModelProvider &&
    editable.every(
      (agent) => (agent.runtimeConfig?.model ?? "") === (first.runtimeConfig?.model ?? ""),
    );
  const sameReasoning =
    sameModel &&
    editable.every(
      (agent) => (agent.runtimeConfig?.reasoning ?? "") === (first.runtimeConfig?.reasoning ?? ""),
    );
  const sameFastMode =
    sameProvider &&
    editable.every(
      (agent) => Boolean(agent.runtimeConfig?.fastMode) === Boolean(first.runtimeConfig?.fastMode),
    );

  return {
    provider: first.provider,
    modelProvider: sameModelProvider ? (first.runtimeConfig?.modelProvider ?? "") : "",
    model: sameModel ? (first.runtimeConfig?.model ?? "") : "",
    reasoning: sameReasoning ? (first.runtimeConfig?.reasoning ?? "") : "",
    fastMode: sameFastMode ? Boolean(first.runtimeConfig?.fastMode) : false,
    ...(sameModel && first.runtimeConfig?.contextWindow !== undefined
      ? { contextWindow: first.runtimeConfig.contextWindow }
      : {}),
    ...(sameModel && first.runtimeConfig?.maxOutputTokens !== undefined
      ? { maxOutputTokens: first.runtimeConfig.maxOutputTokens }
      : {}),
  };
}

export function parseBatchEnvPatch(
  upserts: readonly { key: string; value: string }[],
  removes: readonly string[],
): ParsedBatchEnvPatch {
  const set: Record<string, string> = {};
  for (const row of upserts) {
    const key = row.key.trim();
    if (!key) continue;
    set[key] = row.value;
  }
  const removeSet = new Set<string>();
  const conflictKeys: string[] = [];
  for (const raw of removes) {
    const key = raw.trim();
    if (!key) continue;
    removeSet.add(key);
    if (Object.hasOwn(set, key)) conflictKeys.push(key);
  }
  const remove = [...removeSet];
  return {
    set,
    remove,
    conflictKeys,
    hasAny: Object.keys(set).length > 0 || remove.length > 0,
  };
}

export function collectCommonEnvKeys(
  envKeysByAgent: Readonly<Record<string, readonly string[]>>,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const keys of Object.values(envKeysByAgent)) {
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function selectionRequiresKey(selection: RuntimeSelection | undefined): boolean {
  if (!selection) return false;
  if (RUNTIME_PROVIDER_USES_EXTERNAL_CLI[selection.provider]) return false;
  if (selection.provider === RUNTIME_PROVIDER.PI) {
    return isPiBuiltinModelProvider(selection.modelProvider ?? "");
  }
  return KEYED_MODEL_PROVIDERS.has(selection.modelProvider ?? "");
}

function runtimeSelectionDiffers(
  agent: BatchRuntimePreviewAgent,
  selection: RuntimeSelection,
  apiKey: string,
): boolean {
  if (agent.runtimeConfigInvalid || !agent.provider) return true;
  if (apiKey.trim().length > 0) return true;
  if (agent.provider !== selection.provider) return true;
  const current = agent.runtimeConfig;
  if ((current?.modelProvider ?? "") !== (selection.modelProvider ?? "")) return true;
  if ((current?.model ?? "") !== (selection.model ?? "")) return true;
  if ((current?.reasoning ?? "") !== (selection.reasoning ?? "")) return true;
  if (Boolean(current?.fastMode) !== Boolean(selection.fastMode)) return true;
  const sized = modelSizesApply(selection.provider, selection.modelProvider ?? "");
  if (sized) {
    if (current?.contextWindow !== selection.contextWindow) return true;
    if (current?.maxOutputTokens !== selection.maxOutputTokens) return true;
  }
  return false;
}

export function planBatchRuntimePreview({
  agents,
  computerOnline,
  keepRuntime,
  selection,
  apiKey,
  envPatch,
  envKeysByAgent,
}: {
  agents: readonly BatchRuntimePreviewAgent[];
  computerOnline: boolean;
  keepRuntime: boolean;
  selection: RuntimeSelection | undefined;
  apiKey: string;
  envPatch: BatchEnvPatch;
  envKeysByAgent: Readonly<Record<string, readonly string[]>> | undefined;
}): BatchRuntimePreviewPlan {
  const editableAgents = agents.filter((agent) => agent.ownedByCurrentUser);
  const excludedCount = agents.length - editableAgents.length;
  const setKeys = Object.keys(envPatch.set);
  const removeKeys = envPatch.remove;

  const rows: BatchAgentPreviewRow[] = editableAgents.map((agent) => {
    const runtimeChanged =
      !keepRuntime && selection !== undefined && runtimeSelectionDiffers(agent, selection, apiKey);
    const providerChanged =
      !keepRuntime && selection !== undefined && agent.provider !== selection.provider;

    const existingKeys = envKeysByAgent?.[agent.id];
    const knownKeys = existingKeys ? new Set(existingKeys) : undefined;
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const key of setKeys) {
      if (knownKeys?.has(key)) updated.push(key);
      else added.push(key);
    }
    for (const key of removeKeys) {
      if (!knownKeys || knownKeys.has(key)) removed.push(key);
    }
    const envChanged = added.length > 0 || updated.length > 0 || removed.length > 0;

    let plan: BatchAgentPlanKind = "unchanged";
    if (runtimeChanged || envChanged) {
      if (!computerOnline || agent.stopped) plan = "deferred";
      else if (providerChanged) plan = "restart";
      else plan = "when-idle";
    }

    return {
      agent,
      runtimeChanged,
      providerChanged,
      envChanged,
      envSummary: { added, updated, removed },
      plan,
    };
  });

  const needsApiKey = !keepRuntime && selectionRequiresKey(selection);
  const missingApiKey =
    needsApiKey &&
    apiKey.trim().length === 0 &&
    editableAgents.some(
      (agent) =>
        !agent.hasApiKey ||
        agent.provider !== selection?.provider ||
        (agent.runtimeConfig?.modelProvider ?? "") !== (selection?.modelProvider ?? ""),
    );

  let unchangedCount = 0;
  let whenIdleCount = 0;
  let willRestartCount = 0;
  let deferredCount = 0;
  for (const row of rows) {
    if (row.plan === "unchanged") unchangedCount++;
    else if (row.plan === "when-idle") whenIdleCount++;
    else if (row.plan === "restart") willRestartCount++;
    else deferredCount++;
  }

  return {
    editableAgents,
    excludedCount,
    rows,
    changedCount: rows.length - unchangedCount,
    unchangedCount,
    whenIdleCount,
    willRestartCount,
    deferredCount,
    needsApiKey,
    missingApiKey,
  };
}
