import { FlagdProvider } from "@openfeature/flagd-provider";
import { OpenFeature, type EvaluationContext, type Logger } from "@openfeature/server-sdk";

import type { FeatureFlagsConfiguration } from "./configuration.server";

/**
 * Every feature flag the server evaluates, each off unless the flag file turns it on. A flag is
 * added in the slice that gates its feature and deleted, with every call site, test and
 * assertion that names it, once the feature is on everywhere (docs/feature-flags.md).
 */
export const FEATURE_FLAGS = {
  "app-data-permissions": "Applications phase 2: the data permissions a Workspace grants an app",
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
/** `<flag> <error code>` pairs already logged, so a misconfigured flag logs once, not per call. */
const loggedFailures = new Set<string>();

/** Installs the flag file the boot read (`assertStartupConfig`) as the OpenFeature provider, or,
 * for a disabled configuration, removes any installed provider so that every flag is off. */
export async function installFeatureFlags(configuration: FeatureFlagsConfiguration): Promise<void> {
  loggedFailures.clear();
  configured = false;
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

function evaluationContext({ workspaceId, workspaceSlug }: FeatureFlagContext): EvaluationContext {
  return {
    targetingKey: workspaceId,
    ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
  };
}
