import { readFileSync, writeFileSync } from "node:fs";

export const RUNTIME_OOM_SCORE_ADJ = 500;

export type OomScoreDependencies = {
  platform?: string;
  read?: (path: string) => string;
  write?: (path: string, value: string) => void;
};

/** Gives a Linux Agent child a higher kill priority without making launch depend on /proc. */
export function raiseRuntimeOomScore(
  pid: number | undefined,
  dependencies: OomScoreDependencies = {},
): boolean {
  if ((dependencies.platform ?? process.platform) !== "linux" || pid === undefined) return false;
  const path = `/proc/${pid}/oom_score_adj`;
  try {
    const read = dependencies.read ?? ((file) => readFileSync(file, "utf8"));
    const write = dependencies.write ?? ((file, value) => writeFileSync(file, value));
    const current = Number.parseInt(read(path).trim(), 10);
    if (Number.isFinite(current) && current >= RUNTIME_OOM_SCORE_ADJ) return true;
    write(path, String(RUNTIME_OOM_SCORE_ADJ));
    return true;
  } catch {
    return false;
  }
}
