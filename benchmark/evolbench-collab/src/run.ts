import { join } from "node:path";
import { readKnowledgeAccountCreatedAt, validateKnowledgeReady } from "./knowledge";
import { workspaceProfileToToolFence } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { controlAgent, startAgent, startEvalDaemon, type EvalDaemon } from "./eval-daemon";
import { runEpisode, type EpisodeResult } from "./eval-qa";
import { createEvalDispatcher, drainEpisodeToMemory } from "./ingest";
import { episodesForArm, groupFamilies, loadManifest } from "./manifest";
import { profileFor, reminderForEpisode } from "./benchmarks";
import { classifyMechanism } from "./leak";
import { createAttemptWriter, summarizeArm, writeSummary } from "./report";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  forgetEvalAccountKey,
  provisionDisposableAccount,
  readSecretRootKey,
  rememberEvalAccountKey,
  rootIdentity,
  rotateEvalAdminKey,
  type OvUsers,
} from "../../public-channel-memory/src/ov";
import {
  connectEvalDb,
  destroyEvalWorkspace,
  provisionEvalWorkspace,
  type EvalWorkspace,
} from "./workspace";
import type { ArmSummary, AttemptRow, EpisodeFamily, ManifestEpisode } from "./types";

if (!evalOptedIn()) {
  console.log(`evolbench collaboration eval skipped: set ${EVAL_FLAG}=1`);
  process.exit(0);
}

const env = loadEvalEnv();
Bun.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
process.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
const manifest = await loadManifest(env.manifestPath, env.episodeMod);
const benchmark = env.manifestBenchmark ?? manifest[0]!.benchmark;
const knowledgePath = Bun.env.COFORGE_EVAL_KNOWLEDGE_READY;
const frozenKnowledge = knowledgePath
  ? validateKnowledgeReady(await Bun.file(knowledgePath).json())
  : null;
if (manifest.some((episode) => episode.domain === "information_retrieval") && !frozenKnowledge) {
  throw new Error(
    "IR requires COFORGE_EVAL_KNOWLEDGE_READY; direct BM25/GMS evaluation is disabled",
  );
}
if (
  frozenKnowledge &&
  (env.arms.some((arm) => arm !== frozenKnowledge.arm) ||
    manifest.some((episode) => episode.split !== "test"))
) {
  throw new Error("prepared knowledge arm must match the ready file and use a test-only manifest");
}
const profile = profileFor(benchmark);
const episodeTimeoutMs = env.episodeTimeoutMs ?? profile.episodeTimeoutMs;
const settleMs = env.settleMs ?? profile.settleMs;
const families = groupFamilies(manifest).filter(
  (family) => env.families.length === 0 || env.families.includes(family.familyId),
);
if (families.length === 0) throw new Error("no families selected");
console.log(
  sanitizeDiagnostic(
    `benchmark=${benchmark} manifest=${env.manifestPath} episodes=${manifest.length} mod=${env.episodeMod ?? "-"} families=${families.map((family) => family.familyId).join("|")} arms=${env.arms.join(",")} agents=${env.memoryAgentProvider}/${env.memoryAgentModel}+${env.taskAgentProvider}/${env.taskAgentModel} episodeTimeoutMs=${episodeTimeoutMs} abortQuietMs=${env.abortQuietMs} settleMs=${settleMs} closure=${env.episodeClosure}`,
  ),
);
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";

const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const writer = await createAttemptWriter(
  env.resultDir,
  env.evaluationId,
  (Bun.env.COFORGE_EVAL_RESUME ?? "0") === "1",
);
if (writer.completedRunIds.size > 0) {
  console.log(
    sanitizeDiagnostic(
      `resume: ${writer.completedRunIds.size} episodes already recorded, skipping them`,
    ),
  );
}
const summaries: ArmSummary[] = [];

function runIdFor(arm: "warm" | "cold", episodeId: string): string {
  return `${env.evaluationId}:${episodeId}:${env.seed}:${arm}`;
}

function attemptRow(input: {
  arm: "warm" | "cold";
  family: EpisodeFamily;
  episode: ManifestEpisode;
  workDir: string;
  finalOutput: string | null;
  citationCount: number;
  timedOut: boolean;
  elapsedMs: number;
  mechanism: string;
  error: string | null;
  diagnostics: Pick<
    EpisodeResult,
    "terminationReason" | "runtimeErrorCount" | "lastRuntimeErrorAt" | "lastProgressAt"
  >;
}): AttemptRow {
  const { episode } = input;
  return {
    run_id: runIdFor(input.arm, episode.episodeId),
    benchmark: episode.benchmark || benchmark,
    task_id: episode.taskId,
    episode_id: episode.episodeId,
    family_id: episode.familyId,
    domain: episode.domain,
    arm: input.arm,
    memory_policy: frozenKnowledge
      ? "frozen_readonly"
      : input.arm === "warm"
        ? "read_write"
        : "no_shared_memory",
    seed: env.seed,
    attempt: 1,
    status: input.finalOutput?.trim() ? "success" : "failure",
    duration_seconds: Number((input.elapsedMs / 1000).toFixed(1)),
    work_dir: input.workDir,
    final_output: input.finalOutput ?? "",
    recall_state: input.citationCount > 0 ? "cited" : input.timedOut ? "empty" : "offered",
    recall_citations: input.citationCount,
    mechanism: input.mechanism,
    task_message_count: 0,
    memory_leak_count: 0,
    error: input.error,
    ...input.diagnostics,
  };
}

type FamilyWorkspace = {
  accountId: string;
  workspace: EvalWorkspace;
  daemon: EvalDaemon;
  agentWorkspaceDir: string;
  dispatcher: ReturnType<typeof createEvalDispatcher>;
};

// Crash-resume continuity for the warm arm: drained episode memory lives in the
// OV account, not the workspace, so a resume must rebind to the previous
// segment's account instead of minting a fresh one. The account id is recorded
// per evaluation; COFORGE_EVAL_WARM_REUSE_ACCOUNT_ID overrides it explicitly.
const warmReuseStatePath = join(env.resultDir, `${env.evaluationId}-warm-account.txt`);

async function warmReuseAccountId(): Promise<string> {
  const explicit = (Bun.env.COFORGE_EVAL_WARM_REUSE_ACCOUNT_ID ?? "").trim();
  if (explicit.length > 0) return explicit;
  try {
    return (await Bun.file(warmReuseStatePath).text()).trim();
  } catch {
    return "";
  }
}

async function provisionFamily(
  arm: "warm" | "cold",
  family: EpisodeFamily,
): Promise<FamilyWorkspace> {
  const health = await fetch(new URL("/health", env.ovUrl));
  if (health.status !== 200) throw new Error(`openviking /health ${health.status}`);
  const reuseId = arm === "warm" ? await warmReuseAccountId() : "";
  let accountId: string;
  let users: OvUsers;
  if (frozenKnowledge) {
    accountId = frozenKnowledge.accountId;
    if (
      (await readKnowledgeAccountCreatedAt(runtime, root, accountId)) !==
      frozenKnowledge.accountCreatedAt
    )
      throw new Error(
        "prepared knowledge account was recreated; rebuild knowledge before evaluation",
      );
    const bindings = await db.openVikingBinding.findMany({
      where: { accountId },
      select: { workspaceId: true },
    });
    if (bindings.length > 0)
      throw new Error(
        "prepared knowledge account is already bound; refusing to delete another workspace",
      );
    users = await rotateEvalAdminKey(runtime, root, accountId);
  } else if (reuseId.length > 0) {
    try {
      users = await rotateEvalAdminKey(runtime, root, reuseId);
      accountId = reuseId;
      console.log(sanitizeDiagnostic(`warm arm reusing ov account ${accountId} across resume`));
      // A crash skips releaseFamily, so the previous segment's workspace still
      // holds this account's binding, and the binding store rejects
      // cross-workspace references. Free the account by deleting the stale
      // workspace rows (bindings and mapped identities cascade; OV-side memory
      // is account-scoped and untouched).
      const staleBindings = await db.openVikingBinding.findMany({
        where: { accountId },
        select: { workspaceId: true },
      });
      for (const row of staleBindings) {
        await db.workspace.delete({ where: { id: row.workspaceId } }).catch(() => undefined);
      }
      if (staleBindings.length > 0) {
        console.log(
          sanitizeDiagnostic(
            `freed ${staleBindings.length} stale workspace(s) bound to ${accountId}`,
          ),
        );
      }
    } catch (error) {
      // Account deleted server-side: its memory is unrecoverable, so a fresh
      // provision is the only option — but say so loudly, it silently breaks
      // warm comparability.
      console.warn(
        sanitizeDiagnostic(
          `warm account reuse failed: ${String(error)}; provisioning fresh account`,
        ),
      );
      accountId = `evol-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      users = await provisionDisposableAccount(runtime, root, accountId);
    }
  } else {
    accountId = `evol-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    users = await provisionDisposableAccount(runtime, root, accountId);
  }
  await rememberEvalAccountKey(accountId, users.adminKey);
  if (arm === "warm" && !frozenKnowledge) await Bun.write(warmReuseStatePath, accountId);
  const workspace = await provisionEvalWorkspace({
    db,
    arm,
    familyId: family.familyId,
    benchmark: family.benchmark || benchmark,
    ovAccountId: accountId,
  });
  let daemon: EvalDaemon | undefined;
  try {
    const dispatcher = createEvalDispatcher({ workspace, runtime, accountId, users });
    daemon = await startEvalDaemon({ workspace, env });
    await startAgent(workspace, workspace.memoryAgentId, workspaceProfileToToolFence("openviking"));
    await startAgent(workspace, workspace.taskAgentId);
    return {
      accountId,
      workspace,
      daemon,
      dispatcher,
      agentWorkspaceDir: join(
        daemon.workspaceRoot,
        workspace.workspaceId,
        "agents",
        workspace.taskAgentId,
      ),
    };
  } catch (error) {
    await daemon?.stop().catch(() => undefined);
    await destroyEvalWorkspace(workspace);
    if (arm === "cold" && !frozenKnowledge)
      await deleteDisposableAccount(runtime, root, accountId).catch(() => undefined);
    throw error;
  }
}

async function releaseFamily(arm: "warm" | "cold", provisioned: FamilyWorkspace): Promise<void> {
  await provisioned.daemon.stop().catch(() => undefined);
  await destroyEvalWorkspace(provisioned.workspace);
  if (arm === "warm" || frozenKnowledge) {
    // A prepared account is shared read-only across fresh test workspaces.
    // The warm account carries drained memory; it must outlive this process so
    // a crash-resume can rebind to it. Clean it up manually once the
    // evaluation finishes.
    return;
  }
  await forgetEvalAccountKey(provisioned.accountId).catch(() => undefined);
  await deleteDisposableAccount(runtime, root, provisioned.accountId).catch((error) => {
    console.warn(sanitizeDiagnostic(`ov account cleanup failed: ${String(error)}`));
  });
}

async function executeEpisode(
  arm: "warm" | "cold",
  family: EpisodeFamily,
  episode: ManifestEpisode,
  provisioned: FamilyWorkspace,
): Promise<AttemptRow> {
  if (env.episodeClosure && arm === "warm") {
    // Fresh session per episode: recall + prompt only, no cross-episode model
    // context. The cold arm gets a whole fresh workspace anyway. Do NOT use
    // the managed reset-session chain: its restart start intent is rebuilt
    // server-side without the fence, so the memory agent relaunches with bash.
    // Stop + clear the session pointer + explicit fenced start instead.
    for (const agentId of [
      provisioned.workspace.memoryAgentId,
      provisioned.workspace.taskAgentId,
    ]) {
      await controlAgent(provisioned.workspace, agentId, "stop", undefined).catch((error) => {
        console.warn(
          sanitizeDiagnostic(`closure stop failed for ${episode.episodeId}: ${String(error)}`),
        );
      });
      await provisioned.workspace.db.agent.update({
        where: { id: agentId },
        data: { currentSessionId: null },
      });
    }
    await startAgent(
      provisioned.workspace,
      provisioned.workspace.memoryAgentId,
      workspaceProfileToToolFence("openviking"),
    );
    await startAgent(provisioned.workspace, provisioned.workspace.taskAgentId);
  }
  const reminder = reminderForEpisode(episode.benchmark || benchmark, episode.domain);
  const result = await runEpisode({
    workspace: provisioned.workspace,
    env,
    episode,
    reminder,
    episodeTimeoutMs,
    settleMs,
    runtimeDiagnostics: provisioned.daemon.runtimeDiagnostics,
  });
  const mechanism = classifyMechanism(result);
  let sidecarVerification: AttemptRow["sidecar_verification"] | undefined;
  if (env.verifySidecarUrl) {
    try {
      const response = await fetch(new URL("/verify", env.verifySidecarUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episode_id: episode.episodeId }),
      });
      const verdict = (await response.json()) as {
        episode_id?: string;
        reward?: number;
        graded?: boolean;
        error?: string;
      };
      sidecarVerification = {
        episode_id: episode.episodeId,
        reward: Number(verdict.reward ?? 0),
        graded: Boolean(verdict.graded),
        error: verdict.error ?? null,
      };
      console.log(
        sanitizeDiagnostic(
          `${arm} ${episode.episodeId} sidecar reward=${sidecarVerification.reward} graded=${sidecarVerification.graded}`,
        ),
      );
    } catch (error) {
      console.warn(
        sanitizeDiagnostic(`sidecar verify failed for ${episode.episodeId}: ${String(error)}`),
      );
    }
  }
  const row = attemptRow({
    arm,
    family,
    episode,
    workDir: provisioned.agentWorkspaceDir,
    finalOutput: result.finalOutput,
    citationCount: result.citationCount,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    mechanism,
    error: result.timedOut ? "episode timeout" : null,
    diagnostics: {
      terminationReason: result.terminationReason,
      runtimeErrorCount: result.runtimeErrorCount,
      lastRuntimeErrorAt: result.lastRuntimeErrorAt,
      lastProgressAt: result.lastProgressAt,
    },
  });
  row.knowledge = frozenKnowledge ?? undefined;
  row.memory_request_count = result.memoryRequestCount;
  row.memory_request_message_ids = result.memoryRequestMessageIds;
  row.memory_offer_message_ids = result.offerMessageIds;
  row.memory_dispositions = result.dispositions;
  row.memory_hint_ids = result.memoryHintIds;
  row.memory_reply_message_ids = result.memoryReplyMessageIds;
  row.task_message_count = result.taskMessageCount;
  row.memory_leak_count = result.memoryLeakMessageIds.length;
  row.trajectory_path = join(env.resultDir, `${encodeURIComponent(row.run_id)}-conversation.json`);
  const messages = await provisioned.workspace.db.message.findMany({
    where: { conversationId: provisioned.workspace.channelId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      createdAt: true,
      body: true,
      sender: { select: { agentId: true, userId: true } },
      mentions: { select: { kind: true, actorId: true } },
    },
  });
  await Bun.write(
    row.trajectory_path,
    JSON.stringify(
      {
        episodeId: episode.episodeId,
        workspaceId: provisioned.workspace.workspaceId,
        channelId: provisioned.workspace.channelId,
        messages,
        hintIds: result.memoryHintIds,
        offerMessageIds: result.offerMessageIds,
        dispositions: result.dispositions,
      },
      null,
      2,
    ),
  );
  if (sidecarVerification) row.sidecar_verification = sidecarVerification;
  if (arm === "warm" && !frozenKnowledge) {
    const drained = await drainEpisodeToMemory({
      workspace: provisioned.workspace,
      dispatcher: provisioned.dispatcher,
      channelName:
        family.familyId
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 50) || "evol",
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} ${episode.episodeId} mechanism=${mechanism} citations=${result.citationCount} drained=${drained}`,
      ),
    );
  } else {
    console.log(
      sanitizeDiagnostic(
        `${arm} ${episode.episodeId} mechanism=${mechanism} citations=${result.citationCount}`,
      ),
    );
  }
  await writer.append(row);
  return row;
}

try {
  for (const arm of env.arms) {
    const armRows: AttemptRow[] = [];
    for (const family of families) {
      const episodes = episodesForArm(family, arm);
      if (episodes.length === 0) continue;
      if (arm === "warm" && !frozenKnowledge) {
        const provisioned = await provisionFamily(arm, family);
        try {
          for (const episode of episodes) {
            if (writer.completedRunIds.has(runIdFor(arm, episode.episodeId))) continue;
            armRows.push(await executeEpisode(arm, family, episode, provisioned));
          }
        } finally {
          await releaseFamily(arm, provisioned);
        }
      } else {
        for (const episode of episodes) {
          if (writer.completedRunIds.has(runIdFor(arm, episode.episodeId))) continue;
          const provisioned = await provisionFamily(arm, family);
          try {
            armRows.push(await executeEpisode(arm, family, episode, provisioned));
          } finally {
            await releaseFamily(arm, provisioned);
          }
        }
      }
    }
    summaries.push(summarizeArm(arm, armRows));
  }
  const summaryPath = await writeSummary({
    resultDir: env.resultDir,
    evaluationId: env.evaluationId,
    summaries,
  });
  console.log(sanitizeDiagnostic(`wrote ${writer.path}`));
  console.log(sanitizeDiagnostic(`wrote ${summaryPath}`));
} finally {
  // Known quirk inherited from the sibling evals: prisma $disconnect can hang
  // after results are written; the launcher watchdog pkills the process once
  // it logs `wrote ...-attempts.jsonl`.
  await db.$disconnect();
}
