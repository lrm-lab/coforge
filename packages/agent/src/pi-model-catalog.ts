// Pi's model catalog: the runtime the launch resolves a model through, and what the network says
// about it. Split out of runner.ts, which may not grow (task #30).
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getCoforgeAgentDir } from "./paths";
import { API_KEY_ENV_BY_PROVIDER, configureRuntimeEnvironment } from "./runtime-provider";

export async function discoverPiModels(
  cwd: string,
  options: { agentDir: string; environment?: Readonly<Record<string, string>>; force?: boolean },
) {
  const environment = { ...options.environment };
  const modelRuntime = await createPiModelRuntime(options.agentDir, environment);
  configureRuntimeEnvironment(modelRuntime, environment);
  await refreshPiModelCatalog(modelRuntime, environment, undefined, options.force);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}

export async function createPiModelRuntime(
  agentDir: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // Resolve native environment credentials through Pi so stored auth retains
  // priority. Snapshot single-key auth per session, without patching process.env.
  // OAuth remains SDK-owned so token refresh is not replaced by a static key.
  for (const [provider, variable] of Object.entries(API_KEY_ENV_BY_PROVIDER)) {
    if (!environment[variable] || modelRuntime.isUsingOAuth(provider)) continue;
    const resolved = await modelRuntime.getAuth(provider, { env: { ...environment } });
    if (resolved?.auth.apiKey) await modelRuntime.setRuntimeApiKey(provider, resolved.auth.apiKey);
  }
  return modelRuntime;
}

/** How long a Pi model catalog network refresh may run before it is aborted. */
export const PI_MODEL_REFRESH_TIMEOUT_MS = 5_000;

export async function refreshPiModelCatalog(
  modelRuntime: ModelRuntime,
  environment: Readonly<Record<string, string>>,
  providers?: readonly string[],
  force = false,
) {
  if (Bun.env.PI_OFFLINE !== undefined || environment.PI_OFFLINE !== undefined) {
    if (force) throw new Error("Pi model catalog refresh is unavailable in offline mode");
    return;
  }
  const configuredProviders =
    providers?.filter((provider) => modelRuntime.hasConfiguredAuth(provider)) ??
    modelRuntime
      .getProviders()
      .flatMap((provider) => (modelRuntime.hasConfiguredAuth(provider.id) ? [provider.id] : []));
  if (configuredProviders.length === 0) return;
  // Launches are best-effort and unforced. Without `force`, the SDK's own interval decides when the
  // network is worth hitting, so a slow, offline or hanging network can no longer make every Pi
  // launch wait on (or fail through) a forced catalog fetch. The models already on disk stay
  // usable; a genuinely missing model still fails later, deterministically, at model resolution.
  // Live directory discovery forces a probe and reports failure rather than calling old data fresh.
  try {
    const refreshed = await modelRuntime.refresh({
      providers: configuredProviders,
      allowNetwork: true,
      force,
      signal: AbortSignal.timeout(PI_MODEL_REFRESH_TIMEOUT_MS),
    });
    if (force && (refreshed.aborted || refreshed.errors.size > 0))
      throw new Error("Pi model catalog refresh failed");
  } catch (error) {
    if (force) throw error;
    // A catalog refresh must never fail the launch.
  }
}

/** The models a CoForge-runtime launch can resolve, from the SDK's own catalog. */
export async function discoverModels(cwd: string) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getCoforgeAgentDir(cwd),
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}
