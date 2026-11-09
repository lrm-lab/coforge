export const parse = async (file: string) =>
  Bun.YAML.parse(await Bun.file(`.github/workflows/${file}`).text());

export type Step = {
  id?: string;
  name?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
export type Job = {
  if?: string;
  "runs-on"?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix: { include: Record<string, string>[] } };
};
