import { FlagdProvider } from "@openfeature/flagd-provider";
import {
  OpenFeature,
  ProviderEvents,
  type EvaluationContext,
  type Logger,
} from "@openfeature/server-sdk";

import type { FeatureFlagsConfiguration } from "./configuration.server";

/**
 * Every feature flag the server evaluates, each off unless the flag file turns it on. A flag is
 * added in the slice that gates its feature and deleted, with every call site, test and
 * assertion that names it, once the feature is on everywhere (docs/feature-flags.md).
 */
export const FEATURE_FLAGS = {
  "app-agent-manifest":
    "Applications phase 2: an app's Agent manifest URL, shown to Agents and to the people granting access",
  "app-data-permissions": "Applications phase 2: the data permissions a Workspace grants an app",
  "app-installation-setup":
    "Applications phase 2: the page an app is set up on after installation, and its status",
  "app-marketplace":
    "Applications phase 2: asking for an app to be published to the Marketplace, and reviewing those requests",
  "app-notifications":
    "Applications phase 2: notifying the apps installed in a Workspace of what happens in it",
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/** Who a flag is evaluated for. The Workspace is the targeting key; rules may also match its
 * slug or the signed-in user. */
export type FeatureFlagContext = { workspaceId: string; workspaceSlug?: string };

/** A client reads whichever provider is installed when it evaluates, so one serves every call. */
const client = OpenFeature.getClient();
/** OpenFeature's default provider answers every flag with `PROVIDER_NOT_READY`, so without a
 * flag file the module answers off itself instead of logging an error per call. */
let configured = false;
/** The flags the loaded file marks ENABLED (`isFeatureDefined`), refreshed on every reload. */
let definedFlags: ReadonlySet<string> = new Set();
const changeListeners = new Set<() => void>();
/** Which install a reload belongs to, so a read that outlives its install is dropped. */
let installation = 0;
let removeReloadHandler: (() => void) | undefined;
/** `<flag> <error code>` pairs already logged, so a misconfigured flag logs once, not per call. */
const loggedFailures = new Set<string>();

/** Installs the flag file the boot read (`assertStartupConfig`) as the OpenFeature provider, or,
 * for a disabled configuration, removes any installed provider so that every flag is off. */
export async function installFeatureFlags(configuration: FeatureFlagsConfiguration): Promise<void> {
  loggedFailures.clear();
  const generation = ++installation;
  configured = false;
  definedFlags = new Set();
  removeReloadHandler?.();
  removeReloadHandler = undefined;
  await OpenFeature.clearProviders();
  if (configuration.status === "disabled") return;
  // The resolver and file are explicit, so FLAGD_RESOLVER and FLAGD_OFFLINE_FLAG_SOURCE_PATH
  // cannot redirect the provider.
  await OpenFeature.setProviderAndWait(
    new FlagdProvider(
      { resolverType: "in-process", offlineFlagSourcePath: configuration.definitionsPath },
      PROVIDER_LOGGER,
    ),
  );
  configured = true;
  definedFlags = (await readEnabledFlags(configuration.definitionsPath)) ?? new Set();
  const path = configuration.definitionsPath;
  const onReload = async () => {
    const next = await readEnabledFlags(path);
    if (!next || generation !== installation) return;
    definedFlags = next;
    for (const listener of changeListeners) listener();
  };
  OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, onReload);
  removeReloadHandler = () =>
    OpenFeature.removeHandler(ProviderEvents.ConfigurationChanged, onReload);
}

/** Reports the provider's errors and warnings (an edit to the file that does not parse keeps the
 * previous definitions and reports only here). Its messages can quote the file, so only the level
 * is logged; the file itself shows what is wrong. */
const PROVIDER_LOGGER: Logger = {
  error: () => console.error(JSON.stringify({ event: "feature_flags:provider_error" })),
  warn: () => console.warn(JSON.stringify({ event: "feature_flags:provider_warning" })),
  info: () => {},
  debug: () => {},
};

/** Whether `flag` is on for `context`. Never throws: without a flag file, and on any evaluation
 * error (a flag the file does not define included), the flag is off. */
export async function isFeatureEnabled(
  flag: FeatureFlag,
  context: FeatureFlagContext,
): Promise<boolean> {
  if (!configured) return false;
  const details = await client.getBooleanDetails(flag, false, evaluationContext(context));
  if (details.errorCode === undefined) return details.value;
  const failure = `${flag} ${details.errorCode}`;
  if (!loggedFailures.has(failure)) {
    loggedFailures.add(failure);
    console.warn(
      JSON.stringify({
        event: "feature_flags:evaluation_failed",
        flag,
        error_code: details.errorCode,
        workspace_id: context.workspaceId,
      }),
    );
  }
  return false;
}

/** Whether the flag file defines `flag` as ENABLED, for any Workspace: what decides whether a
 * feature that needs setup before its first use (a queue, a schema) must be set up before anyone
 * turns it on. It reads the loaded definitions, never evaluates targeting. A flag the file lacks,
 * or marks DISABLED, is not defined; so is every flag while no file is configured. */
export function isFeatureDefined(flag: FeatureFlag): boolean {
  return definedFlags.has(flag);
}

/** Calls `listener` after the module has re-read the definitions of a reloaded flag file (the file
 * is polled, so an edit applies without a restart). A reload that does not parse is ignored.
 * Returns the function that stops listening; listeners survive `installFeatureFlags`. */
export function onFeatureFlagsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

/** The keys of the flags a flagd definition file marks ENABLED, or nothing if it does not parse. */
async function readEnabledFlags(path: string): Promise<Set<string> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    const flags = (parsed as { flags?: Record<string, { state?: unknown }> } | null)?.flags;
    if (typeof flags !== "object" || flags === null) return undefined;
    return new Set(Object.keys(flags).filter((key) => flags[key]?.state === "ENABLED"));
  } catch {
    return undefined;
  }
}

function evaluationContext({ workspaceId, workspaceSlug }: FeatureFlagContext): EvaluationContext {
  return {
    targetingKey: workspaceId,
    ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
  };
}
