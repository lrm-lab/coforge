// E2E flows (task #coforge-designer-team:#128): a browser e2e is kept for the product's key user
// flows only, as Frank asked ("端到端测试不要什么都加"). A commit that adds an `.e2e.ts` under
// apps/web/test names the flow it covers in an `E2E-Flow: <flow>` trailer, one of E2E_FLOWS. A
// single screen, a style, a spacing or one interaction is a unit test, an integration test or the
// layout sweep instead, and so is a bug fix outside these flows. Changing an existing e2e, or
// renaming one, needs no trailer. docs/agents/testing.md states the rule.

/** The key user flows a browser e2e may cover, and what each is. */
export const E2E_FLOWS = {
  "sign-in": "signing in and onboarding",
  messaging: "sending and reading messages",
  "task-flow": "a Task moving through its statuses",
  "artifact-sharing": "publishing and sharing an artifact",
  "agent-connect": "connecting an Agent or a Computer",
  notifications: "notifications and realtime delivery",
} as const;
export type E2EFlow = keyof typeof E2E_FLOWS;

const flowList = Object.keys(E2E_FLOWS)
  .map((flow) => `\`${flow}\``)
  .join(", ");

export const E2E_FLOW_FIX = `A new browser e2e covers a key user flow only. If it does, add \`E2E-Flow: <flow>\` to the message, one of ${flowList}. A single screen, a style, a spacing, one interaction, or a bug outside those flows is a unit test, an integration test (apps/web/test/*.integration.ts) or the layout sweep (apps/web/scripts/ui-sweep.mjs) instead (docs/agents/testing.md).`;

const NEW_E2E = /^apps\/web\/test\/.+\.e2e\.ts$/;
const TRAILER = /^E2E-Flow:[ \t]*(\S+)[ \t]*$/m;

/** The flow a message's `E2E-Flow:` trailer names, if it names one of E2E_FLOWS. */
export function e2eFlowOf(message: string): E2EFlow | undefined {
  const flow = TRAILER.exec(message)?.[1];
  return flow !== undefined && Object.hasOwn(E2E_FLOWS, flow) ? (flow as E2EFlow) : undefined;
}

/** The browser e2e files among `added` (paths a commit adds, renames excluded). */
export function newE2eFiles(added: readonly string[]): string[] {
  return added.filter((path) => NEW_E2E.test(path));
}

/** What is wrong with a commit that adds `added` under `message`, if anything. */
export function e2eFlowProblem(message: string, added: readonly string[]): string | undefined {
  const files = newE2eFiles(added);
  if (files.length === 0 || e2eFlowOf(message)) return undefined;
  const named = TRAILER.exec(message)?.[1];
  return `${named ? `E2E-Flow \`${named}\` is not a key flow` : "no E2E-Flow trailer"} for new ${files.join(", ")}`;
}

const gitText = (args: string[], cwd?: string) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Each non-merge commit `base..head` adds that adds a browser e2e without a key flow. */
export function rangeE2eFlowViolations(base: string, head: string, cwd?: string) {
  const violations: { sha: string; found: string }[] = [];
  for (const sha of lines(
    gitText(["rev-list", "--reverse", "--no-merges", `${base}..${head}`], cwd),
  )) {
    const added = lines(
      gitText(["show", "--format=", "--name-only", "--diff-filter=A", "-M", "-l0", sha], cwd),
    );
    const problem = e2eFlowProblem(gitText(["show", "-s", "--format=%B", sha], cwd), added);
    if (problem) violations.push({ sha: sha.slice(0, 9), found: problem });
  }
  return violations;
}

/** The commit-msg hook's half: the files the commit being written adds, from the index. */
export function stagedE2eFlowProblem(message: string, cwd?: string) {
  const added = lines(
    gitText(["diff", "--cached", "--name-only", "--diff-filter=A", "-M", "-l0"], cwd),
  );
  return e2eFlowProblem(message, added);
}
