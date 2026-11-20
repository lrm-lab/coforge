import type { TaskClaimConflict, TaskClaimResult, TaskResult } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { shortId } from "#src/short-id";
import { taskRefForTarget } from "#src/task-ref";
import { blockedClaimRow } from "#src/task-relations-format";

/** How a claim conflict's blocked actions read. */
const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

function claimLabel(claim: TaskClaimResult): string {
  return claim.number ? `#${claim.number}` : `msg:${claim.messageId}`;
}

function holder(conflict: TaskClaimConflict): string {
  const { name, deleted } = conflict.currentAssignee;
  return `@${name}${deleted ? " [deleted]" : ""}`;
}

function claimRow(claim: TaskClaimResult): string {
  const label = claimLabel(claim);
  if (claim.success) return `${label} (msg:${shortId(claim.messageId ?? "")}): claimed`;
  if (claim.conflict) {
    const { conflict } = claim;
    const blocked = conflict.blockedActions
      .map((action) => BLOCKED_ACTION_COPY[action] ?? action)
      .join("; ");
    return [
      `${label}: Claim failed — ${holder(conflict)} currently holds the implementation lock (assignment state as of ${conflict.observedAt}).`,
      `  Blocked: ${blocked}.`,
      `  Not blocked by this claim conflict (each still subject to its own authority/policy): ${conflict.unblockedActionExamples.join(" · ")}.`,
      "  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted, correct the routing in the original thread.",
    ].join("\n");
  }
  if (claim.reason === "blocked" && claim.blockedBy) return blockedClaimRow(label, claim);
  return `${label}: FAILED — ${claim.reason || "refused"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
}

/** Each claim selector's outcome as `coforge task claim` prints it, then the claimed Tasks' threads. */
export function formatClaimResults(target: string, result: TaskResult): string {
  const claims = result.claims ?? [];
  const claimed = claims.filter((claim) => claim.success && claim.number !== undefined);
  const failed = claims.length - claims.filter((claim) => claim.success).length;
  const lines = [
    `Claim results (${claims.length - failed} claimed${failed ? `, ${failed} failed` : ""}):`,
    ...claims.map(claimRow),
  ];
  if (claimed.length) {
    const taskConversationRefs = claimed
      .filter((claim) => !claim.messageId)
      .map((claim) => taskRefForTarget(target, claim.number!));
    const isDm = target.startsWith("@") || target.startsWith("dm:@");
    const where = isDm
      ? "in a 1-on-1 DM, on the DM's own timeline unless they wrote in a thread or the task"
      : "the source message's thread, or the task if they created it or wrote in it";
    lines.push(
      "",
      "Follow up in each task's thread:",
      ...claimed.map((claim) => {
        const ref = taskRefForTarget(target, claim.number!);
        const reply = claim.messageId
          ? `coforge message send --target "${target}:${shortId(claim.messageId)}"`
          : `coforge task reply "${ref}"`;
        return `${ref} → ${reply}`;
      }),
      ...(taskConversationRefs.length
        ? [
            "",
            `Answer the person who asked where they spoke (${where}); this shows who created the task and its source:`,
            ...taskConversationRefs.map((ref) => `coforge task view "${ref}"`),
          ]
        : []),
    );
  }
  return lines.join("\n");
}

/**
 * The refusal `coforge task claim` fails with when no selector was claimed, carrying the printed
 * rows; undefined when at least one claim authorises work.
 */
export function claimRefusal(target: string, result: TaskResult): CliError | undefined {
  const claims = result.claims ?? [];
  if (claims.some((claim) => claim.success)) return undefined;
  const summary = claims
    .map(
      (claim) =>
        `${claimLabel(claim)} ${claim.conflict ? `held by ${holder(claim.conflict)}` : claim.reason || "refused"}`,
    )
    .join("; ");
  return new CliError({
    code: claims.some((claim) => claim.conflict) ? "CLAIM_CONFLICT" : "CLAIM_FAILED",
    message: `Claim refused — ${summary}. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.`,
    retryable: false,
    contextText: formatClaimResults(target, result),
    suggestedNextAction:
      "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
  });
}
