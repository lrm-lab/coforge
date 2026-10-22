import { EVAL_ARMS, type EvalArm } from "./types";

/** Same pin as Pi `~/.pi/agent/models.json` and the sibling evals. */
export const PI_DEEPSEEK_V4_FLASH_PROVIDER = "lenovo-deepseek-v4-flash";
export const PI_DEEPSEEK_V4_FLASH_MODEL = "DeepSeek";

export type EvalEnv = {
  manifestPath: string;
  manifestBenchmark: string | null;
  families: string[];
  arms: EvalArm[];
  seed: number;
  evaluationId: string;
  databaseUrl: string;
  redisUrl: string;
  ovUrl: string;
  ovConfPath: string;
  webUrl: string | null;
  memoryAgentProvider: string;
  memoryAgentModel: string;
  taskAgentProvider: string;
  taskAgentModel: string;
  pollMs: number;
  episodeTimeoutMs: number | null;
  settleMs: number | null;
  /** Episode closure between warm episodes: reset-session both agents. */
  episodeClosure: boolean;
  /** Appended to every episode prompt after %TASK_ID%/%EPISODE_ID%/%%SIDECAR%%
   * substitution — used for env-sidecar wiring (SkillLearnBench, ...). */
  envNote: string | null;
  /** Env sidecar that can verify an episode (POST /verify {episode_id}). */
  verifySidecarUrl: string | null;
  /** Shard filter for order-independent episode streams: "N:k" keeps episodes
   * whose zero-based manifest index satisfies index % N === k. */
  episodeMod: string | null;
  /** Bail out early when nothing at all is happening (no offer AND no task
   * message for this many ms) instead of riding the full deadline. */
  abortQuietMs: number;
  resultDir: string;
  /** Parallel-sedimentation protocol: JSON file {accountId, adminUserId,
   * adminKey} redirecting cold-arm episode drains from the per-episode
   * disposable account into one shared corpus account. */
  drainAccountFile: string | null;
  /** Run cold-arm episodes regardless of split (batch train sedimentation). */
  coldAllSplits: boolean;
};

const FLAG = "COFORGE_EVOLBENCH_COLLAB_EVAL";

export function evalOptedIn(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[FLAG] === "1" || env[FLAG] === "true";
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

export function loadEvalEnv(env: Record<string, string | undefined> = Bun.env): EvalEnv {
  const arms = (env.COFORGE_EVAL_ARMS ?? "warm,cold")
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm): arm is EvalArm => (EVAL_ARMS as readonly string[]).includes(arm));
  if (arms.length === 0) throw new Error("COFORGE_EVAL_ARMS has no recognized arm (warm|cold)");
  const manifestPath = required(env, "COFORGE_EVAL_MANIFEST");
  const memoryAgentProvider =
    env.COFORGE_EVAL_MEMORY_AGENT_PROVIDER ?? PI_DEEPSEEK_V4_FLASH_PROVIDER;
  const memoryAgentModel = env.COFORGE_EVAL_MEMORY_AGENT_MODEL ?? PI_DEEPSEEK_V4_FLASH_MODEL;
  const taskAgentProvider = env.COFORGE_EVAL_TASK_AGENT_PROVIDER ?? memoryAgentProvider;
  const taskAgentModel = env.COFORGE_EVAL_TASK_AGENT_MODEL ?? memoryAgentModel;
  return {
    manifestPath,
    manifestBenchmark: env.COFORGE_EVAL_MANIFEST_BENCHMARK?.trim() || null,
    families: (env.COFORGE_EVAL_FAMILIES ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    arms,
    seed: Number(env.COFORGE_EVAL_SEED ?? "1"),
    evaluationId:
      env.COFORGE_EVALUATION_ID ?? `evol-collab-${new Date().toISOString().slice(0, 10)}`,
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    ovUrl: env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:1933",
    ovConfPath:
      env.OPENVIKING_PROTOTYPE_CONF ??
      new URL("../../../infra/secrets/openviking_prototype_ov_conf", import.meta.url).pathname,
    webUrl: env.COFORGE_WEB_URL ?? null,
    memoryAgentProvider,
    memoryAgentModel,
    taskAgentProvider,
    taskAgentModel,
    pollMs: Number(env.COFORGE_EVAL_POLL_MS ?? "5000"),
    episodeTimeoutMs: env.COFORGE_EVAL_EPISODE_TIMEOUT_MS
      ? Number(env.COFORGE_EVAL_EPISODE_TIMEOUT_MS)
      : null,
    settleMs: env.COFORGE_EVAL_SETTLE_MS ? Number(env.COFORGE_EVAL_SETTLE_MS) : null,
    episodeClosure: (env.COFORGE_EVAL_EPISODE_CLOSURE ?? "1") !== "0",
    envNote: env.COFORGE_EVAL_ENV_NOTE?.trim() || null,
    verifySidecarUrl: env.COFORGE_EVAL_VERIFY_SIDECAR?.trim() || null,
    episodeMod: env.COFORGE_EVAL_EPISODE_MOD?.trim() || null,
    abortQuietMs: Number(env.COFORGE_EVAL_ABORT_QUIET_MS ?? "600000"),
    resultDir: env.COFORGE_EVAL_RESULT_DIR ?? new URL("../result", import.meta.url).pathname,
    drainAccountFile: env.COFORGE_EVAL_DRAIN_ACCOUNT_FILE?.trim() || null,
    coldAllSplits: env.COFORGE_EVAL_COLD_ALL_SPLITS === "1",
  };
}

export const EVAL_FLAG = FLAG;
