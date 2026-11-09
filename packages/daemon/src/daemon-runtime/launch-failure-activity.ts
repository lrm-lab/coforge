import {
  buildLaunchFailureActivity as buildFailureActivity,
  cleanupUnconfirmed as cleanupFailure,
} from "./agent-failure-presentation";

type Provider = Parameters<typeof buildFailureActivity>[1];
type Drafts = Parameters<typeof buildFailureActivity>[3];

export function cleanupUnconfirmed(
  agentId: string,
  error: unknown,
  isStopping: (agentId: string) => boolean,
): boolean {
  return cleanupFailure(agentId, error, isStopping);
}

export function buildLaunchFailureActivity(
  agentId: string,
  provider: Provider,
  error: unknown,
  drafts: Drafts,
  isStopping: (agentId: string) => boolean,
): ReturnType<typeof buildFailureActivity> {
  return buildFailureActivity(agentId, provider, error, drafts, (id, err) =>
    cleanupFailure(id, err, isStopping),
  );
}
